//! `SERVICE-013` / `A-32`: the fixture-seeding **development** command.
//!
//! `SERVICE-013` removed fixture resurrection from service startup and placed
//! fixture setup "in tests and development commands". This is that command, and
//! it is deliberately a separate binary: the service binary (`agent-service`)
//! cannot reach it, so no normal startup — however configured — can seed,
//! restore, or resurrect an application row. The no-reseed invariant is unchanged.
//!
//! It refuses to run unless `VIVA_DEV_FIXTURE_SEED=1` is set explicitly, and it
//! invents no default database: `DATABASE_URL` must name the target. The seed
//! itself is `data::seed_postgres_fixture`, which is insert-only and refuses to
//! overwrite an existing fixture root — including a deletion tombstone
//! (`COR-03`/`SEC-03`) — so this command can never put deleted learner material
//! back.
//!
//! Usage (CI browser job and local gates), against a disposable database:
//!
//! ```text
//! VIVA_DEV_FIXTURE_SEED=1 \
//! DATABASE_URL=postgresql://viva:...@127.0.0.1:55432/viva_browser_e2e \
//!   cargo run -p agent-service --bin viva-dev-seed-fixture
//! ```

use std::process::ExitCode;

use agent_service::{
    dev_fixture_seed_request, seed_dev_fixture, VIVA_DEV_FIXTURE_SEED_ACKNOWLEDGEMENT,
};

#[tokio::main]
async fn main() -> ExitCode {
    let acknowledgement = std::env::var(VIVA_DEV_FIXTURE_SEED_ACKNOWLEDGEMENT).ok();
    let database_url = std::env::var("DATABASE_URL").ok();
    let request =
        match dev_fixture_seed_request(acknowledgement.as_deref(), database_url.as_deref()) {
            Ok(request) => request,
            Err(error) => {
                // The refusal names the missing input only. A connection string can
                // carry a password, so it is never echoed.
                eprintln!("viva-dev-seed-fixture refused: {error}");
                return ExitCode::FAILURE;
            }
        };
    match seed_dev_fixture(&request).await {
        Ok(()) => {
            println!("viva-dev-seed-fixture: development fixture seeded");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("viva-dev-seed-fixture failed: {error}");
            ExitCode::FAILURE
        }
    }
}
