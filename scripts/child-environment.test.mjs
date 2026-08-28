import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CHILD_ENVIRONMENT_ROLES, childEnvironmentFor } from "./child-environment.mjs";

// A real fixture child: it only ever reports its own environment's key/value
// pairs as JSON and exits 0, regardless of what it finds. Every assertion in
// this file inspects the reported content, never `child.exitCode` — proving
// (per RELEASE-029's adversarial-control requirement) that a leak is caught
// even though the fixture itself always "succeeds".
const PROBE_SOURCE = "process.stdout.write(JSON.stringify(process.env));\n";

// A hostile parent process: legitimate operational values sitting alongside
// database/provider/auth/failure-control secrets, unrelated VIVA_* flags,
// and a runtime-injection attempt via NODE_OPTIONS/BUN_OPTIONS. None of the
// sentinel values below may ever reach a spawned child unless a role's own
// typed explicit map is asked, by name, to carry it.
const HOSTILE_PARENT_ENV = Object.freeze({
  PATH: "/hostile/bin:/usr/bin",
  HOME: "/home/hostile-parent",
  TMPDIR: "/tmp/hostile-parent-tmp",
  CI: "1",
  LANG: "en_US.UTF-8",
  DATABASE_URL: "postgres://hostile:leak@internal-db.example/prod",
  CARTESIA_API_KEY: "hostile-cartesia-key-value",
  GEMINI_API_KEY: "hostile-gemini-key-value",
  AWS_SECRET_ACCESS_KEY: "hostile-aws-secret-value",
  VIVA_VOICE_SESSION_TOKEN_SECRET: "hostile-session-signing-secret",
  VIVA_VOICE_WS_BEARER_TOKEN: "hostile-bearer-token-value",
  VIVA_FAILURE_CONTROL_SECRET: "hostile-failure-control-secret",
  VIVA_AGENT_PROVIDER: "hostile-provider-override",
  VIVA_RELEASE_RUN_ID: "hostile-release-run-id",
  VIVA_RELEASE_CHECK_SKIP_BROWSER: "hostile-skip-browser-flag",
  VIVA_PRODUCTION_RELEASE: "hostile-production-release-flag",
  VIVA_SOME_UNRELATED_FLAG: "hostile-unrelated-value",
  NODE_OPTIONS: "--require /tmp/viva-hostile-parent.cjs",
  BUN_OPTIONS: "--hostile-flag",
});

const OPERATIONAL_HOSTILE_KEYS = Object.freeze(["PATH", "HOME", "TMPDIR", "CI", "LANG"]);
const SENTINEL_KEYS = Object.freeze(
  Object.keys(HOSTILE_PARENT_ENV).filter((key) => !OPERATIONAL_HOSTILE_KEYS.includes(key)),
);

async function withProbe(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "viva-child-env-probe-"));
  const probePath = path.join(dir, "probe.mjs");
  await writeFile(probePath, PROBE_SOURCE);
  try {
    return await fn(probePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runProbe(probePath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// `explicitlySupplied` is the exact `explicit` object the test passed to
// `childEnvironmentFor` to build `env`. A sentinel-shaped key the role
// legitimately requested is allowed to be present, but only carrying the
// test's own explicit value — never the hostile parent's same-named value
// (proving the role reads its config from normalized input, not from the
// ambient parent by name). Every other sentinel key/value must be wholly
// absent from what the real spawned child actually observes.
async function assertNoSentinelLeak(env, explicitlySupplied = {}) {
  await withProbe(async (probePath) => {
    const { code, stdout } = await runProbe(probePath, env);
    assert.equal(code, 0, "fixture child must exit 0 regardless of leaked content");
    const reported = JSON.parse(stdout);
    const serialized = JSON.stringify(reported);
    for (const key of SENTINEL_KEYS) {
      if (Object.hasOwn(explicitlySupplied, key)) {
        assert.equal(
          reported[key],
          String(explicitlySupplied[key]),
          `explicit value for ${key} was not honored`,
        );
        assert.notEqual(
          reported[key],
          HOSTILE_PARENT_ENV[key],
          `explicit value for ${key} was overridden by the hostile parent`,
        );
        continue;
      }
      assert.equal(key in reported, false, `sentinel key ${key} leaked into the child environment`);
      const value = HOSTILE_PARENT_ENV[key];
      assert.equal(
        serialized.includes(value),
        false,
        `sentinel value from ${key} leaked into the child environment`,
      );
    }
  });
}

test("child-environment defines the expected roles", () => {
  assert.deepEqual(
    [...CHILD_ENVIRONMENT_ROLES].sort(),
    [
      "dev-agent",
      "hosted-browser",
      "hosted-live",
      "local-browser-agent",
      "local-browser-audio",
      "local-browser-web",
      "release-check-command",
      "release-check-provider-readiness",
    ].sort(),
  );
});

test("childEnvironmentFor rejects an unknown role", () => {
  assert.throws(
    () => childEnvironmentFor("not-a-real-role", { parentEnv: {}, explicit: {} }),
    /unknown role/,
  );
});

test("childEnvironmentFor requires an explicit parentEnv", () => {
  assert.throws(() => childEnvironmentFor("dev-agent", { explicit: {} }), /parentEnv is required/);
});

test("childEnvironmentFor rejects an unknown explicit key before spawn for every role", () => {
  for (const role of CHILD_ENVIRONMENT_ROLES) {
    assert.throws(
      () =>
        childEnvironmentFor(role, {
          parentEnv: {},
          explicit: { VIVA_NOT_A_ROLE_KEY: "value" },
        }),
      /does not allow explicit key/,
      `role ${role} must reject an unlisted explicit key`,
    );
  }
});

test("childEnvironmentFor never falls back to an extra-object escape hatch", () => {
  const built = childEnvironmentFor("dev-agent", {
    parentEnv: { PATH: "/bin" },
    explicit: { VIVA_AGENT_PROVIDER: "synthetic" },
  });
  assert.deepEqual(Object.keys(built).sort(), ["PATH", "VIVA_AGENT_PROVIDER"]);
});

test("childEnvironmentFor omits a role key entirely when not supplied explicitly, even if the parent carries it", () => {
  const built = childEnvironmentFor("dev-agent", {
    parentEnv: { PATH: "/bin", VIVA_AGENT_PROVIDER: "ambient-leak" },
    explicit: {},
  });
  assert.equal("VIVA_AGENT_PROVIDER" in built, false);
});

test("hosted-monitor-runner: hosted-browser role clears a hostile parent and keeps only explicit identity/target values", async () => {
  const explicit = {
    NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID: "legit-study-set",
    VIVA_E2E_AGENT_PROVIDER: "synthetic",
    VIVA_E2E_HOSTED_WEB_URL: "https://legit-web.example.com",
  };
  const env = childEnvironmentFor("hosted-browser", { parentEnv: HOSTILE_PARENT_ENV, explicit });
  assert.equal(env.NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID, "legit-study-set");
  assert.equal(env.VIVA_E2E_AGENT_PROVIDER, "synthetic");
  assert.equal(env.PATH, "/hostile/bin:/usr/bin");
  await assertNoSentinelLeak(env, explicit);
});

test("hosted-monitor-runner: hosted-browser role rejects the session-token signing secret as an explicit key", () => {
  // No hosted-browser-routed run ever needs this: every session-auth
  // failure-control scenario (expired_token and its siblings) requires
  // explicit browser action and is unconditionally excluded from the hosted
  // PR matrix (see FAILURE_CONTROL_SCENARIOS_REQUIRING_BROWSER_ACTION in
  // hosted-e2e-matrix.mjs), so this role must not even be able to accept it
  // -- granting it would widen the role's blast radius for no run that can
  // ever exist.
  assert.throws(
    () =>
      childEnvironmentFor("hosted-browser", {
        parentEnv: {},
        explicit: { VIVA_VOICE_SESSION_TOKEN_SECRET: "should-be-rejected" },
      }),
    /does not allow explicit key/,
  );
});

test("hosted-monitor-runner: hosted-live role never receives raw provider keys or the session-signing secret", async () => {
  const explicit = {
    VIVA_AGENT_PROVIDER: "cartesia_gemini",
    VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED: "1",
    VIVA_LIVE_SMOKE_SESSION_TOKEN: "legit-minted-session-token",
  };
  const env = childEnvironmentFor("hosted-live", { parentEnv: HOSTILE_PARENT_ENV, explicit });
  assert.equal(env.VIVA_AGENT_PROVIDER, "cartesia_gemini");
  assert.equal(env.VIVA_LIVE_PROVIDER_SECRETS_CONFIRMED, "1");
  assert.equal("CARTESIA_API_KEY" in env, false);
  assert.equal("GEMINI_API_KEY" in env, false);
  assert.equal("VIVA_VOICE_SESSION_TOKEN_SECRET" in env, false);
  await assertNoSentinelLeak(env, explicit);
});

test("e2e-browser: local-browser-agent role clears a hostile parent and keeps only its explicit bind/provider values", async () => {
  const explicit = { VIVA_AGENT_BIND_ADDR: "127.0.0.1:0", VIVA_AGENT_PROVIDER: "synthetic" };
  const env = childEnvironmentFor("local-browser-agent", {
    parentEnv: HOSTILE_PARENT_ENV,
    explicit,
  });
  assert.equal(env.VIVA_AGENT_BIND_ADDR, "127.0.0.1:0");
  assert.equal(env.VIVA_AGENT_PROVIDER, "synthetic");
  await assertNoSentinelLeak(env, explicit);
});

// W-07: the local signed-session story's own durable-store configuration. The
// caller CONSTRUCTS these; the hostile parent's own `DATABASE_URL` and session
// secret still cannot reach the child, because the role names
// `VIVA_AGENT_DATABASE_URL` and nothing is ever copied by name from the parent.
test("e2e-browser: local-browser-agent role takes a constructed durable-store URL and never the parent's own DATABASE_URL", async () => {
  const explicit = {
    VIVA_AGENT_BIND_ADDR: "127.0.0.1:0",
    VIVA_AGENT_DATABASE_URL: "postgresql://viva:local@127.0.0.1:55433/viva_browser_e2e",
    VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: "viva-local-e2e-agent-scoped-read-material0",
    VIVA_AGENT_PROVIDER: "synthetic",
    VIVA_VOICE_SESSION_TOKEN_SECRET: "viva-local-e2e-session-token-material-0000",
  };
  const env = childEnvironmentFor("local-browser-agent", {
    parentEnv: HOSTILE_PARENT_ENV,
    explicit,
  });
  assert.equal(env.VIVA_AGENT_DATABASE_URL, explicit.VIVA_AGENT_DATABASE_URL);
  assert.equal(
    env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN,
    explicit.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN,
  );
  assert.equal(env.VIVA_VOICE_SESSION_TOKEN_SECRET, explicit.VIVA_VOICE_SESSION_TOKEN_SECRET);
  assert.equal("DATABASE_URL" in env, false);
  await assertNoSentinelLeak(env, explicit);
});

// W-07 / A-32: without a session-mint credential configured on the agent
// itself, nothing may call `record_voice_session` at start -- the newly
// started session's `voice_sessions` row is never written, its authenticated
// projection can never validate, and `/session` opens no socket. `config.rs`'s
// `validate_credentials` also collision-checks every scoped agent credential
// pairwise, so this must reach the agent byte-distinct from the library-read
// credential above even though the harness constructs both as local literals.
test("e2e-browser: local-browser-agent role takes a constructed session-mint credential distinct from the library-read credential", async () => {
  const explicit = {
    VIVA_AGENT_BIND_ADDR: "127.0.0.1:0",
    VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: "viva-local-e2e-agent-scoped-read-material0",
    VIVA_AGENT_PROVIDER: "synthetic",
    VIVA_AGENT_SESSION_MINT_BEARER_TOKEN: "viva-local-e2e-session-mint-bearer-material-0",
    VIVA_VOICE_SESSION_TOKEN_SECRET: "viva-local-e2e-session-token-material-0000",
  };
  const env = childEnvironmentFor("local-browser-agent", {
    parentEnv: HOSTILE_PARENT_ENV,
    explicit,
  });
  assert.equal(
    env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN,
    explicit.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN,
  );
  assert.notEqual(
    env.VIVA_AGENT_SESSION_MINT_BEARER_TOKEN,
    env.VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN,
  );
  await assertNoSentinelLeak(env, explicit);
});

test("e2e-browser: local-browser-web role clears a hostile parent and keeps only its explicit NEXT_PUBLIC values", async () => {
  const explicit = { NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: "http://127.0.0.1:0" };
  const env = childEnvironmentFor("local-browser-web", { parentEnv: HOSTILE_PARENT_ENV, explicit });
  assert.equal(env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL, "http://127.0.0.1:0");
  await assertNoSentinelLeak(env, explicit);
});

// W-07: the merged D-07 Branch A server-side landing contract. Without these
// the landing's Start action is structurally unavailable and no affordance on
// the page can reach `POST /api/viva-session/start`.
test("e2e-browser: local-browser-web role takes the constructed signed-start configuration and no ambient value", async () => {
  const explicit = {
    NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: "http://127.0.0.1:0",
    VIVA_AGENT_HTTP_URL: "http://127.0.0.1:0",
    VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: "viva-local-e2e-agent-scoped-read-material0",
    VIVA_AGENT_REST_BEARER_TOKEN: "viva-local-e2e-agent-scoped-read-material0",
    VIVA_AGENT_SESSION_MINT_BEARER_TOKEN: "viva-local-e2e-agent-scoped-read-material0",
    VIVA_SESSION_ALLOWED_STUDY_SET_IDS: "biology-midterm",
    VIVA_SESSION_ALLOWED_USER_IDS: "user-1",
    VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET: "viva-local-e2e-bootstrap-token-material-0",
    VIVA_VOICE_SESSION_TOKEN_SECRET: "viva-local-e2e-session-token-material-0000",
    VIVA_WEB_CANONICAL_ORIGIN: "http://127.0.0.1:0",
    VIVA_WEB_SINGLE_INSTANCE: "1",
  };
  const env = childEnvironmentFor("local-browser-web", { parentEnv: HOSTILE_PARENT_ENV, explicit });
  for (const [key, value] of Object.entries(explicit)) {
    assert.equal(env[key], value, `${key} must be the constructed value`);
  }
  assert.equal("DATABASE_URL" in env, false);
  assert.equal("CARTESIA_API_KEY" in env, false);
  await assertNoSentinelLeak(env, explicit);

  // The web child is not an agent: it may not be handed the agent's own
  // durable-store URL, and the role refuses rather than silently dropping it.
  assert.throws(
    () =>
      childEnvironmentFor("local-browser-web", {
        parentEnv: {},
        explicit: { VIVA_AGENT_DATABASE_URL: "postgresql://viva:local@127.0.0.1:55433/x" },
      }),
    /does not allow explicit key/,
  );
});

test("dev-agent role clears a hostile parent and keeps only its explicit loopback configuration", async () => {
  const explicit = { VIVA_AGENT_BIND_ADDR: "127.0.0.1:0", VIVA_AGENT_PROVIDER: "synthetic" };
  const env = childEnvironmentFor("dev-agent", { parentEnv: HOSTILE_PARENT_ENV, explicit });
  assert.equal(env.VIVA_AGENT_BIND_ADDR, "127.0.0.1:0");
  await assertNoSentinelLeak(env, explicit);
});

test("release-check: release-check-command role clears a hostile parent and keeps only its explicit command values", async () => {
  const explicit = { VIVA_E2E_ARTIFACT_DIR: "artifacts/legit" };
  const env = childEnvironmentFor("release-check-command", {
    parentEnv: HOSTILE_PARENT_ENV,
    explicit,
  });
  assert.equal(env.VIVA_E2E_ARTIFACT_DIR, "artifacts/legit");
  await assertNoSentinelLeak(env, explicit);
});

test("release-check: release-check-provider-readiness role only carries its own constructed placeholder provider keys, never the parent's", async () => {
  const explicit = {
    CARTESIA_API_KEY: "legit-placeholder-cartesia-key",
    GEMINI_API_KEY: "legit-placeholder-gemini-key",
    VIVA_AGENT_BIND_ADDR: "127.0.0.1:0",
    VIVA_AGENT_PROVIDER: "cartesia_gemini",
  };
  const env = childEnvironmentFor("release-check-provider-readiness", {
    parentEnv: HOSTILE_PARENT_ENV,
    explicit,
  });
  assert.equal(env.CARTESIA_API_KEY, "legit-placeholder-cartesia-key");
  assert.equal(env.GEMINI_API_KEY, "legit-placeholder-gemini-key");
  await assertNoSentinelLeak(env, explicit);
});

test("adversarial control: the leak assertion fails on a leaking env even though the fixture child exits 0", async () => {
  const leaking = {
    ...childEnvironmentFor("dev-agent", { parentEnv: HOSTILE_PARENT_ENV, explicit: {} }),
  };
  leaking.DATABASE_URL = HOSTILE_PARENT_ENV.DATABASE_URL;
  await withProbe(async (probePath) => {
    const { code } = await runProbe(probePath, leaking);
    assert.equal(code, 0, "the fixture must still report success despite the leak");
  });
  await assert.rejects(() => assertNoSentinelLeak(leaking), /sentinel key DATABASE_URL leaked/);
});
