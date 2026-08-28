// RELEASE-030 E2E extraction: Playwright/local-service lifecycle, explicit
// child environments, port retry, and managed teardown. Nothing here reduces
// evidence or drives a page's own actions -- it hands the story module a
// ready browser context and resolved agent/web addresses, and tears both back
// down on request.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { childEnvironmentFor } from "./child-environment.mjs";
import {
  awaitPortBound,
  freePort,
  spawnManaged,
  spawnWithPortRetry,
  SUPERVISOR_DEFAULT_GRACE_MS,
} from "./process-supervisor.mjs";
import {
  LOCAL_STORY_AGENT_SCOPED_BEARER,
  LOCAL_STORY_BOOTSTRAP_TOKEN_SECRET,
  LOCAL_STORY_IDENTITY,
  LOCAL_STORY_SESSION_MINT_BEARER,
  LOCAL_STORY_SESSION_TOKEN_SECRET,
} from "./e2e-browser-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// RELEASE-015: local children are supervised process groups; see
// `spawnLocalChild` below for the teardown rationale this lane's Task 7 wrote.
const SPAWN_LOGGED_ROLES = Object.freeze({
  agent: "local-browser-agent",
  audio: "local-browser-audio",
  web: "local-browser-web",
});

const children = [];

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchChromium() {
  const options = {
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  };
  try {
    return await chromium.launch(options);
  } catch (error) {
    const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (
      process.platform === "darwin" &&
      error instanceof Error &&
      error.message.includes("Executable doesn't exist")
    ) {
      return await chromium.launch({ ...options, executablePath: systemChrome });
    }
    throw error;
  }
}

/**
 * RELEASE-015: `cargo run` and `bun run --cwd apps/web dev` are both wrappers.
 * Each execs a further process that owns the loopback port, so signalling the
 * wrapper's own pid left an agent-service or a Next dev server behind — which
 * the next run then either raced or, worse, talked to. Every local child is a
 * supervised process group, torn down with SIGTERM to the group, a bounded
 * grace, and SIGKILL only when the group refuses.
 */
export function spawnLocalChild({ name, command, args, artifactDir, extraEnv = {}, logName = name }) {
  const role = SPAWN_LOGGED_ROLES[name];
  if (!role) {
    throw new Error(`spawnLocalChild: unknown local child "${name}"`);
  }
  const handle = spawnManaged({
    command,
    args,
    cwd: root,
    // RELEASE-029: the locally-spawned agent/web children never inherit this
    // process's own ambient environment — only the fixed operational
    // allowlist plus this role's own explicit, typed configuration.
    env: childEnvironmentFor(role, { parentEnv: process.env, explicit: extraEnv }),
    stdoutPath: path.join(artifactDir, `${logName}.stdout.log`),
    stderrPath: path.join(artifactDir, `${logName}.stderr.log`),
    label: `e2e ${logName}`,
  });
  children.push(handle);
  return handle;
}

export async function stopLocalChildren() {
  for (const child of [...children].reverse()) {
    await child.stop({ graceMs: SUPERVISOR_DEFAULT_GRACE_MS }).catch(() => {});
  }
  children.length = 0;
}

/**
 * Spawn the local agent-service child. `webUrl` is the runtime-resolved local
 * web origin (or the hosted one is never used here — hosted mode never calls
 * this); `plan` is the frozen `buildE2EPlan()` result.
 */
export async function spawnLocalAgent(plan, { webUrl }) {
  let agentPort = null;
  const started = await spawnWithPortRetry({
    label: "local agent-service",
    attempts: 2,
    start: ({ port }) => {
      agentPort = port;
      return spawnLocalChild({
        name: "agent",
        command: "cargo",
        args: ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
        artifactDir: plan.artifactDir,
        extraEnv: {
          VIVA_AGENT_BIND_ADDR: `127.0.0.1:${port}`,
          // W-07: signed-session mode is available to the local agent only over
          // a durable store, and its authenticated projection route only where
          // the scoped library-read credential exists beside the session-token
          // secret. Both ride the caller-supplied disposable database URL; with
          // no database the agent stays in its documented trusted-loopback mode
          // and `assertLocalSignedSessionSupport` refuses the story up front.
          VIVA_AGENT_DATABASE_URL: plan.localAgentDatabaseUrl,
          VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: plan.localSignedSessionMode
            ? LOCAL_STORY_AGENT_SCOPED_BEARER
            : "",
          VIVA_AGENT_PROVIDER: plan.agentProvider,
          // W-07 / A-32: without this the agent has no caller authorized to
          // record a started voice session, `authenticated_study_projection`
          // can never validate the row the web tier's signed start minted,
          // and `/session` opens no socket -- the exact deadlock A-32 closed
          // at the product layer, reproduced here if the harness omits it.
          VIVA_AGENT_SESSION_MINT_BEARER_TOKEN: plan.localSignedSessionMode
            ? LOCAL_STORY_SESSION_MINT_BEARER
            : "",
          VIVA_VOICE_SESSION_TOKEN_SECRET: plan.failureControlPlan.enabled
            ? plan.failureControlEnv.VIVA_VOICE_SESSION_TOKEN_SECRET
            : plan.localSignedSessionMode
              ? LOCAL_STORY_SESSION_TOKEN_SECRET
              : "",
          VIVA_VOICE_WS_ALLOWED_ORIGINS: webUrl,
          ...plan.failureControlEnv,
        },
      });
    },
    // A cold `cargo run` compiles the workspace before it binds anything.
    observeBind: ({ handle, port }) => awaitPortBound({ handle, port, timeoutMs: 600_000 }),
  });
  return { handle: started.value, port: agentPort };
}

/** Spawn the local Next.js web child on the already-allocated `webPort`. */
export async function spawnLocalWeb(plan, { agentUrl, webUrl, wsUrl, webPort }) {
  return spawnLocalChild({
    name: "web",
    command: "bun",
    args: [
      "run",
      "--cwd",
      "apps/web",
      "dev",
      "--",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(webPort),
    ],
    artifactDir: plan.artifactDir,
    extraEnv: {
      NEXT_PUBLIC_VIVA_AGENT_WS_URL: wsUrl,
      NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: agentUrl,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID:
        plan.failureControlIdentity?.userId ?? LOCAL_STORY_IDENTITY.userId,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID:
        plan.failureControlIdentity?.studySetId ?? LOCAL_STORY_IDENTITY.studySetId,
      NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID: "voice-session-1",
      // W-07: the merged D-07 Branch A server-side landing contract. Without
      // these the landing's Start action is structurally unavailable and no
      // page affordance can mint a session.
      VIVA_AGENT_HTTP_URL: agentUrl,
      VIVA_AGENT_LIBRARY_READ_BEARER_TOKEN: LOCAL_STORY_AGENT_SCOPED_BEARER,
      // The landing server component reads the broad name for its own initial
      // snapshot fetch; the scoped names are what the route handlers use.
      VIVA_AGENT_REST_BEARER_TOKEN: LOCAL_STORY_AGENT_SCOPED_BEARER,
      // W-07 / A-32: byte-distinct from the library-read credential above --
      // must match the value the agent child is itself configured to accept
      // for `session_mint_credential` (`spawnLocalAgent`), never the
      // library-read one, or the agent's own collision check refuses to
      // start.
      VIVA_AGENT_SESSION_MINT_BEARER_TOKEN: LOCAL_STORY_SESSION_MINT_BEARER,
      VIVA_SESSION_ALLOWED_STUDY_SET_IDS:
        plan.failureControlIdentity?.studySetId ?? LOCAL_STORY_IDENTITY.studySetId,
      VIVA_SESSION_ALLOWED_USER_IDS:
        plan.failureControlIdentity?.userId ?? LOCAL_STORY_IDENTITY.userId,
      VIVA_SESSION_BOOTSTRAP_TOKEN_SECRET: LOCAL_STORY_BOOTSTRAP_TOKEN_SECRET,
      VIVA_VOICE_SESSION_TOKEN_SECRET: plan.failureControlPlan.enabled
        ? plan.failureControlEnv.VIVA_VOICE_SESSION_TOKEN_SECRET
        : LOCAL_STORY_SESSION_TOKEN_SECRET,
      VIVA_WEB_CANONICAL_ORIGIN: webUrl,
      VIVA_WEB_SINGLE_INSTANCE: "1",
    },
  });
}

export function authenticatedHostedFetchOptions(bearerToken) {
  const headers = new Headers();
  headers.set("Authorization", ["Bearer", bearerToken].join(" "));
  return { headers };
}

export async function waitForHttp(url, timeoutMs, label) {
  await waitForHttpJson(url, () => true, timeoutMs, label);
}

export async function waitForHttpJson(url, predicate, timeoutMs, label, fetchOptions) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    const earlyExit = children.find(
      (child) => child.exitResult && (child.exitResult.code ?? child.exitResult.signal) !== 0,
    );
    if (earlyExit) {
      const status = earlyExit.exitResult.code ?? earlyExit.exitResult.signal;
      throw new Error(`${label} dependency exited early with ${status}`);
    }
    try {
      const response = await fetch(url, fetchOptions);
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (response.ok && predicate(json, response)) return json;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export { freePort };
