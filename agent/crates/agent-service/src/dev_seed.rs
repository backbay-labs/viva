//! `SERVICE-013` / `A-32`: the fixture-seeding **development** command's decision layer.
//!
//! `SERVICE-013` removed fixture resurrection from service startup and placed
//! fixture setup "in tests and development commands". The decision layer lives
//! here, in its own module, rather than in `config.rs`: the plan's structural
//! control requires `config.rs` to name `seed_postgres_fixture` exactly once (its
//! ignored Postgres no-reseed test), and startup configuration is not where a
//! development command belongs. The module is reachable only from the separate
//! `viva-dev-seed-fixture` binary, never from `main.rs`.

/// The environment variable that acknowledges a fixture seed is a development
/// action. Only the exact value `1` authorizes it.
pub const VIVA_DEV_FIXTURE_SEED_ACKNOWLEDGEMENT: &str = "VIVA_DEV_FIXTURE_SEED";

/// The exact acknowledgement value. Anything else — blank, `0`, `true`, or a
/// whitespace-padded `1` — is refused, so an ambient environment cannot drift
/// into seeding a database.
pub const VIVA_DEV_FIXTURE_SEED_ACKNOWLEDGED: &str = "1";

/// An acknowledged, fully-specified fixture-seed request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DevFixtureSeedRequest {
    pub database_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DevFixtureSeedError {
    #[error(
        "fixture seeding is a development command, never a startup step; \
         set VIVA_DEV_FIXTURE_SEED=1 to run it"
    )]
    DevelopmentAcknowledgementRequired,
    #[error("VIVA_DEV_FIXTURE_SEED=1 requires a non-empty DATABASE_URL")]
    DatabaseUrlRequired,
    #[error("fixture seed could not connect: {0}")]
    Connect(String),
    #[error("fixture seed could not migrate: {0}")]
    Migrate(String),
    #[error("fixture seed refused: {0}")]
    Seed(String),
}

/// `SERVICE-013`: fixture setup is "in tests and development commands", outside
/// `build_study_store`. This is that development command's decision layer.
///
/// Both inputs are explicit and required. There is no default database and no
/// implied acknowledgement, so the only way to reach a seed is to ask for one by
/// name — which is why the no-reseed invariant at startup is unaffected: nothing
/// on the service's own startup path sets either variable, and the service binary
/// never calls this.
pub fn dev_fixture_seed_request(
    acknowledgement: Option<&str>,
    database_url: Option<&str>,
) -> Result<DevFixtureSeedRequest, DevFixtureSeedError> {
    if acknowledgement != Some(VIVA_DEV_FIXTURE_SEED_ACKNOWLEDGED) {
        return Err(DevFixtureSeedError::DevelopmentAcknowledgementRequired);
    }
    let database_url = database_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(DevFixtureSeedError::DatabaseUrlRequired)?;
    Ok(DevFixtureSeedRequest {
        database_url: database_url.to_owned(),
    })
}

/// Runs the acknowledged request: connect, migrate, then seed exactly once.
///
/// `COR-03`/`SEC-03` are preserved untouched — `data::seed_postgres_fixture` is
/// insert-only and refuses outright when a fixture root already exists, including
/// a deletion tombstone. That refusal is surfaced, never swallowed, so a caller
/// can tell "seeded" from "already present" and neither is reported as the other.
pub async fn seed_dev_fixture(request: &DevFixtureSeedRequest) -> Result<(), DevFixtureSeedError> {
    let pool = data::connect_pg(&data::PgConfig::new(request.database_url.clone()))
        .await
        .map_err(|error| DevFixtureSeedError::Connect(error.to_string()))?;
    data::run_migrations(&pool)
        .await
        .map_err(|error| DevFixtureSeedError::Migrate(error.to_string()))?;
    data::seed_postgres_fixture(&pool)
        .await
        .map_err(|error| DevFixtureSeedError::Seed(error.to_string()))
}

/// `SERVICE-013`'s no-reseed invariant and the shape of the development command
/// that satisfies its "tests and development commands" half: an explicit
/// acknowledgement, an explicit target, its own binary, and a `config.rs` that
/// still names the durable seed exactly once.
#[cfg(test)]
mod dev_fixture_seed_tests {
    use super::*;

    const A_DATABASE_URL: &str =
        "postgresql://viva:viva_test_only@127.0.0.1:55432/viva_service_test";

    /// Nothing but the exact acknowledgement authorizes a seed. A blank, absent,
    /// falsey, truthy-looking, or merely whitespace-padded value is refused, so no
    /// ambient environment can drift into seeding.
    #[test]
    fn dev_fixture_seed_requires_the_exact_development_acknowledgement() {
        for acknowledgement in [
            None,
            Some(""),
            Some(" "),
            Some("0"),
            Some("true"),
            Some("yes"),
            Some("on"),
            Some("1 "),
            Some(" 1"),
            Some("11"),
        ] {
            assert_eq!(
                dev_fixture_seed_request(acknowledgement, Some(A_DATABASE_URL)),
                Err(DevFixtureSeedError::DevelopmentAcknowledgementRequired),
                "{acknowledgement:?} must not authorize a fixture seed",
            );
        }
    }

    /// An acknowledged request still needs an explicit target. The command never
    /// invents a default database.
    #[test]
    fn dev_fixture_seed_requires_an_explicit_database_url() {
        for database_url in [None, Some(""), Some("   ")] {
            assert_eq!(
                dev_fixture_seed_request(Some("1"), database_url),
                Err(DevFixtureSeedError::DatabaseUrlRequired),
                "{database_url:?} must not authorize a fixture seed",
            );
        }
    }

    #[test]
    fn dev_fixture_seed_accepts_the_acknowledged_request_and_trims_its_target() {
        assert_eq!(
            dev_fixture_seed_request(Some("1"), Some(&format!("  {A_DATABASE_URL}  "))),
            Ok(DevFixtureSeedRequest {
                database_url: A_DATABASE_URL.to_owned(),
            }),
        );
    }

    /// `SERVICE-013`'s no-reseed invariant, still pinned: the startup store entry
    /// point reaches neither the fixture seed nor this development command, and the
    /// service binary names no seed at all.
    #[test]
    fn normal_startup_never_reaches_the_fixture_seed() {
        const CONFIG_SOURCE: &str = include_str!("config.rs");
        const SERVICE_MAIN_SOURCE: &str = include_str!("main.rs");
        let startup = CONFIG_SOURCE
            .split_once("pub async fn build_study_store")
            .expect("build_study_store is the startup store entry point")
            .1
            .split_once("\n}\n")
            .expect("build_study_store closes")
            .0;
        // The durable branch is what `SERVICE-013` is about: it may connect and
        // migrate, and it may write no application row. The in-memory branch's
        // process-local `InMemoryStudyStore::seeded_fixture()` is not a durable
        // write and is deliberately not in scope here.
        for forbidden in ["seed_postgres_fixture", "seed_dev_fixture"] {
            assert!(
                !startup.contains(forbidden),
                "normal startup must not reach `{forbidden}`",
            );
        }
        assert!(
            !SERVICE_MAIN_SOURCE.contains("seed"),
            "the service binary must name no seed at all",
        );
    }

    /// The development entry point is a separate binary, so it cannot run as a side
    /// effect of starting the service, and it is the only place the durable fixture
    /// seed is reachable from this crate.
    #[test]
    fn the_development_entry_point_is_its_own_binary_over_this_decision_layer() {
        const DEV_SEED_BIN_SOURCE: &str = include_str!("bin/dev_seed_fixture.rs");
        const MANIFEST: &str = include_str!("../Cargo.toml");
        for required in [
            "dev_fixture_seed_request",
            "seed_dev_fixture",
            "VIVA_DEV_FIXTURE_SEED",
            "DATABASE_URL",
        ] {
            assert!(
                DEV_SEED_BIN_SOURCE.contains(required),
                "the development seed binary must go through `{required}`",
            );
        }
        assert!(
            MANIFEST.contains("name = \"viva-dev-seed-fixture\""),
            "the development seed binary is declared, and named for what it is",
        );
        assert!(
            MANIFEST.contains("path = \"src/bin/dev_seed_fixture.rs\""),
            "the declared development binary is this source file",
        );
    }

    /// The plan's own structural control, executed rather than merely quoted:
    /// `config.rs` names the durable fixture seed exactly once — its ignored
    /// Postgres no-reseed test — so startup configuration can never quietly grow a
    /// second seed call site, and this development command may not move back in.
    #[test]
    fn config_names_the_durable_fixture_seed_exactly_once() {
        const CONFIG_SOURCE: &str = include_str!("config.rs");
        let occurrences = CONFIG_SOURCE
            .lines()
            .filter(|line| line.contains("seed_postgres_fixture"))
            .collect::<Vec<_>>();
        assert_eq!(
            occurrences.len(),
            1,
            "config.rs must name seed_postgres_fixture exactly once, found: {occurrences:#?}",
        );
        assert!(
            occurrences[0].contains("data::seed_postgres_fixture(&pool)"),
            "the one remaining reference is the ignored Postgres test's own seed call, \
             not a startup path: {}",
            occurrences[0],
        );
    }

    /// A second `[[bin]]` makes an unqualified `cargo run -p agent-service`
    /// ambiguous unless the package declares which binary it means. That exact argv
    /// is what `scripts/dev-agent.mjs` builds for `bun run dev:agent`, what
    /// `scripts/frontend-harness.mjs` spawns for the browser gates, and what the
    /// agent README and the deployment runbook tell an operator to type — so the
    /// development seed command may not cost the service its own default run.
    #[test]
    fn the_service_binary_stays_the_packages_default_run() {
        const MANIFEST: &str = include_str!("../Cargo.toml");
        let declared_binaries = MANIFEST.matches("[[bin]]").count();
        assert!(
            declared_binaries > 1,
            "this guard exists because the package declares more than one binary",
        );
        assert!(
            MANIFEST.contains("default-run = \"agent-service\""),
            "with {declared_binaries} binaries declared, `cargo run -p agent-service` \
             resolves only through an explicit default-run",
        );
    }
}
