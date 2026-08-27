import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildDevAgentEnv, devAgentArgs } from "./dev-agent.mjs";

/**
 * `scripts/frontend-harness.mjs` — the reusable, bounded loopback
 * process/browser lifecycle that `scripts/frontend-accessibility.mjs` and
 * `scripts/frontend-performance.mjs` mount real Next.js pages through.
 *
 * Task 2 landed the subset of that lifecycle it needed (loopback port
 * allocation, a sanitized-env `next dev` child, Chromium launch/teardown,
 * and a minimal local library-snapshot stub so `.viva-library__*` selectors
 * have real content to render for the computed-style baseline).
 *
 * Task 11 completes it (`FRONTEND-009`):
 *
 * - `withFrontendProductionServer` — `next start` against an already
 *   completed `apps/web` build (it never builds; `frontend-performance.mjs`
 *   requires the caller to run `bun run --cwd apps/web build` first, so a
 *   sampling run can never silently measure a stale or dev-mode bundle).
 * - `startSyntheticAgent`/`waitForHttpJson` — the real synthetic Rust
 *   agent-service (`agent/crates/agent-service`, `VIVA_AGENT_PROVIDER=
 *   synthetic`) in place of `startLibrarySnapshotStub`'s HTTP fixture, for
 *   checks that need an actual `/session` connection rather than only the
 *   landing library's static snapshot. With no `DATABASE_URL`,
 *   `build_study_store` (`agent/crates/agent-service/src/config.rs`) falls
 *   back to `InMemoryStudyStore::seeded_fixture()` — the same
 *   `"biology-midterm"`/`"user-1"` identity this harness's own
 *   `LIBRARY_SNAPSHOT_FIXTURE`-shaped fixtures already use — and with
 *   `VIVA_VOICE_SESSION_TOKEN_SECRET`/`VIVA_VOICE_WS_BEARER_TOKEN` both left
 *   unset (`buildDevAgentEnv`'s own default, reused here rather than
 *   duplicated), `authenticate_upgrade` accepts every `/ws` upgrade as
 *   `UpgradePrincipal::ServiceBearer` without verifying a signature — the
 *   same unsigned/trust posture `scripts/dev-agent.mjs` already uses for
 *   local dev, never a real database, session-signing, or provider-key
 *   secret.
 * - `setCpuThrottlingRate` — CDP `Emulation.setCPUThrottlingRate` for a
 *   mounted `page`.
 * - The fuller no-secret environment clearing a hosted gate requires: the
 *   real provider-key names this app actually reads (`CARTESIA_API_KEY`,
 *   `GEMINI_API_KEY` — `redaction-control.mjs`'s own denylist names the
 *   same two) alongside the generic placeholders Task 2 already cleared,
 *   and the agent's own WS bearer token.
 */

export const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const appsWebDir = path.join(repoRoot, "apps/web");
const nextBin = path.join(appsWebDir, "node_modules/.bin/next");

/**
 * Ambient variable names this harness must never let a spawned Next.js
 * process inherit, so a frontend-only mounted check can never accidentally
 * talk to a real database, a real provider, or a real signed-session
 * secret. Task 11's "no-secret gate" extends this list; this is the subset
 * relevant to what `next dev` reads today.
 */
const AMBIENT_VARS_TO_CLEAR = new Set([
  "DATABASE_URL",
  "VIVA_DATABASE_URL",
  "VIVA_VOICE_SESSION_TOKEN_SECRET",
  "VIVA_VOICE_WS_BEARER_TOKEN",
  "VIVA_AGENT_HTTP_URL",
  "VIVA_AGENT_REST_BEARER_TOKEN",
  "VIVA_SESSION_ALLOWED_USER_IDS",
  "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
  "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
  "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
  "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
  // The real provider keys this app reads (matches
  // `scripts/redaction-control.mjs`'s own denylist names) plus generic
  // placeholders no code here reads, cleared defensively regardless.
  "CARTESIA_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
]);
const AMBIENT_VAR_PREFIXES_TO_CLEAR = [
  "VIVA_HOSTED_",
  "VIVA_E2E_",
  "VIVA_FAILURE_CONTROL_",
  "VIVA_RELEASE_",
];

/** A sanitized environment for a spawned frontend-harness child process. */
export function sanitizedEnv(extra = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (AMBIENT_VARS_TO_CLEAR.has(key)) delete clean[key];
    else if (AMBIENT_VAR_PREFIXES_TO_CLEAR.some((prefix) => key.startsWith(prefix))) {
      delete clean[key];
    }
  }
  return { ...clean, NEXT_TELEMETRY_DISABLED: "1", ...extra };
}

/** Allocates a free loopback TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("could not allocate a free local port"));
      });
    });
  });
}

/**
 * Spawns a child process, tees its stdout/stderr to sanitized log files
 * under `artifactDir`, and returns a handle whose `stop()` always
 * terminates it. Callers must `stop()` this in a `finally` block.
 */
export function spawnLogged(name, command, args, { cwd, env, artifactDir }) {
  mkdirSync(artifactDir, { recursive: true });
  const stdout = createWriteStream(path.join(artifactDir, `${name}.stdout.log`));
  const stderr = createWriteStream(path.join(artifactDir, `${name}.stderr.log`));
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let exited = false;
  let exitCode = null;
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? signal;
      resolve(exitCode);
    });
  });
  return {
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    exit,
    stop() {
      if (!exited) child.kill("SIGTERM");
      stdout.end();
      stderr.end();
    },
  };
}

/** Polls `url` until it responds at all (any status) or `timeoutMs` elapses. */
export async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      // Any response at all — including a 4xx/5xx from a route that is
      // still mid-compile on the very first hit — means the server is up.
      void response.body?.cancel?.();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(
    `timed out waiting ${timeoutMs}ms for ${label} at ${url}: ${lastError?.message ?? lastError}`,
  );
}

/**
 * Launches Chromium with fake media devices, matching this repo's e2e
 * harness. `--enable-precise-memory-info` asks Chromium for a finer-grained
 * `performance.memory.usedJSHeapSize` than its default coarse bucketing —
 * `scripts/frontend-performance.mjs`'s heap-growth budget needs real
 * resolution, not a value quantized to the nearest ~100 KB.
 */
export async function launchChromium() {
  return chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--enable-precise-memory-info",
    ],
  });
}

/**
 * A tiny local HTTP stub standing in for the library-snapshot GET endpoint
 * of the agent-service's REST surface — scoped to exactly what a mounted
 * frontend check needs (a deterministic, non-null `VivaLibrarySnapshot` so
 * `.viva-library__*` selectors have real content to render). It ignores
 * auth headers and query strings entirely; it is not a security boundary,
 * only a fixture server on an ephemeral loopback port. Task 11 replaces
 * this with the real synthetic Rust agent-service per its Step 3.
 */
export function startLibrarySnapshotStub(snapshot) {
  const body = JSON.stringify(snapshot);
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Starts `apps/web` under `next dev` on a free loopback port with a
 * sanitized environment, waits for it to answer, runs `callback({
 * baseUrl })`, and always terminates the child afterward.
 */
export async function withFrontendDevServer({ artifactDir, extraEnv = {} }, callback) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnLogged("next-dev", nextBin, ["dev", "-p", String(port)], {
    cwd: appsWebDir,
    env: sanitizedEnv(extraEnv),
    artifactDir,
  });
  try {
    await waitForHttp(`${baseUrl}/`, 180_000, "next dev");
    return await callback({ baseUrl });
  } finally {
    child.stop();
    await child.exit;
  }
}

/**
 * Polls `url`, parsing each response body as JSON, until `predicate(json)`
 * is true or `timeoutMs` elapses. Any response (including a non-2xx one, or
 * one whose body does not parse as JSON) is passed to `predicate` as
 * `undefined` rather than thrown — only the predicate decides readiness.
 *
 * @param {string} url
 * @param {(json: unknown) => boolean} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
export async function waitForHttpJson(url, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (predicate(json)) return json;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `timed out waiting ${timeoutMs}ms for ${label} at ${url}: ${lastError?.message ?? lastError}`,
  );
}

/**
 * Starts the real synthetic Rust agent-service on a free loopback port and
 * waits for `/ready` to report it ready under the synthetic provider. See
 * this file's top-of-file doc comment for why no database secret is
 * required or set. Returns the agent's REST base URL, its `/ws` WebSocket
 * URL, and a `close()` that always terminates the child.
 *
 * By default this leaves `VIVA_VOICE_SESSION_TOKEN_SECRET`/
 * `VIVA_VOICE_WS_BEARER_TOKEN` unset (`buildDevAgentEnv`'s own default), so
 * `authenticate_upgrade` accepts a `/ws` connection unconditionally as
 * `UpgradePrincipal::ServiceBearer` — sufficient for `/health`, `/ready`,
 * and a `/ws` upgrade attempt alone.
 *
 * `sessionTokenSecret` exists for a future caller with a real durable
 * store, but is **not usable against this harness's in-memory agent
 * today** — confirmed empirically, not merely inferred from reading the
 * source: `agent/crates/agent-service/src/config.rs`'s
 * `validate_runtime_store_preflight` requires a durable (Postgres) store
 * the moment *any* `VIVA_VOICE_SESSION_TOKEN_SECRET` is configured, unless
 * the bind is loopback AND `VIVA_FAILURE_CONTROL_ENABLED=1` — a different
 * testing subsystem (deliberate injected-failure scenarios) this harness
 * must not repurpose as a signing bypass. Passing it against an in-memory
 * store crashes the agent at startup with "public signed-session mode
 * requires a durable store". The same gate blocks every signed capability
 * this app has: `signed_library_action`/`signed_library_control_token`
 * (`agent/crates/agent-service/src/http/library.rs`, which mint a
 * study-set's `session_bootstrap_token`/`session_token` and the library
 * control token) and `ProjectionReadAccess::authorize`
 * (`agent/crates/agent-service/src/config.rs`, the agent's own
 * `/v1/study-sets/{id}/projection` route) all require the identical
 * secret. There is consequently no way for a database-free harness to
 * reach a `LiveSessionShell` mount through the real, fully-signed
 * production path (landing → real `Start` click → real
 * `/api/viva-session/start` → real `/api/viva-session/projection` → a
 * WS the agent verifies) — every one of those steps needs the agent to
 * sign something. `routeSyntheticSessionProjection` below is how this
 * harness reaches a real, mounted session anyway: it intercepts only the
 * one same-origin HTTP call that gate blocks
 * (`/api/viva-session/projection`), on the browser side, with a
 * structurally valid projection shaped like the agent's own seeded
 * `"biology-midterm"` fixture — never a signature, a database, or the
 * unrelated failure-control subsystem.
 *
 * `port` defaults to a fresh loopback port, correct for a caller that also
 * controls the Next.js server's own `NEXT_PUBLIC_VIVA_AGENT_WS_URL`/
 * `HTTP_URL` env — which `next dev` re-reads per request, but `next start`
 * cannot: `NEXT_PUBLIC_*` values are inlined into the client bundle at
 * `next build` time, so setting them only when *starting* an already-built
 * production server has no effect on it at all.
 * `withFrontendProductionServer` callers must instead pass the fixed
 * `port: 4318` (`viva-agent-client.ts`'s own hardcoded fallback,
 * `defaultVivaAgentWsUrl`, and `scripts/dev-agent.mjs`'s own default bind
 * port — not a coincidence, the same "no env configured" default both
 * already agree on) so a production build compiled with no agent env at
 * all still finds the real agent.
 *
 * @param {{ artifactDir: string, port?: number, sessionTokenSecret?: string }} options
 */
export async function startSyntheticAgent({ artifactDir, port, sessionTokenSecret }) {
  const boundPort = port ?? (await freePort());
  const url = `http://127.0.0.1:${boundPort}`;
  const source = { ...sanitizedEnv(), VIVA_AGENT_BIND_ADDR: `127.0.0.1:${boundPort}` };
  if (sessionTokenSecret) {
    source.VIVA_DEV_AGENT_SIGNED_SESSION = "1";
    source.VIVA_VOICE_SESSION_TOKEN_SECRET = sessionTokenSecret;
  }
  const env = buildDevAgentEnv(source);
  const child = spawnLogged("agent", "cargo", devAgentArgs(), {
    artifactDir,
    cwd: repoRoot,
    env,
  });
  try {
    await waitForHttpJson(
      `${url}/ready`,
      (json) =>
        typeof json === "object" &&
        json !== null &&
        json.ready === true &&
        json.brain?.provider === "synthetic",
      120_000,
      "synthetic agent readiness",
    );
  } catch (error) {
    child.stop();
    await child.exit;
    throw error;
  }
  return {
    async close() {
      child.stop();
      await child.exit;
    },
    url,
    wsUrl: `ws://127.0.0.1:${boundPort}/ws`,
  };
}

/**
 * A structurally valid `AuthenticatedStudyProjectionV1` (see
 * `packages/core/src/study-projection-contract.ts`) shaped after the real
 * synthetic agent's own seeded fixture
 * (`InMemoryStudyStore::seeded_fixture()`,
 * `agent/crates/data/src/memory.rs`): the same `"biology-midterm"` study
 * set, the same four concepts/labels/statuses, and the same
 * `"q-oxidative-phosphorylation-nadh"` question this harness's own
 * `LIBRARY_SNAPSHOT_FIXTURE`-shaped fixtures already use elsewhere, so a
 * mounted session's rendered identity is never invented independently of
 * what the rest of this harness claims about the same study set.
 */
export const SYNTHETIC_SESSION_PROJECTION_FIXTURE = Object.freeze({
  activeQuestion: {
    conceptId: "oxidative-phosphorylation",
    id: "q-oxidative-phosphorylation-nadh",
    prompt: "Explain the role of NADH in oxidative phosphorylation.",
    sourceCitations: [
      {
        confidence: "high",
        documentId: "lec-5",
        label: "Lecture 5, slide 18",
        sourceId: "src-lecture-5-slide-18",
        span: "slide:18",
      },
    ],
  },
  concepts: [
    {
      dueAt: null,
      id: "oxidative-phosphorylation",
      label: "Oxidative phosphorylation",
      lastReviewedAt: null,
      status: "shaky",
    },
    { dueAt: null, id: "nadh", label: "NADH", lastReviewedAt: null, status: "review" },
    {
      dueAt: null,
      id: "atp-synthase",
      label: "ATP synthase",
      lastReviewedAt: null,
      status: "review",
    },
    {
      dueAt: null,
      id: "cellular-respiration",
      label: "Cellular respiration",
      lastReviewedAt: null,
      status: "shaky",
    },
  ],
  questionProgress: { completed: 0, total: 1 },
  reviewSchedule: [],
  session: { goal: null, id: "harness-session-1", mode: "quiz" },
  studySet: {
    course: "Biology 201",
    examLabel: null,
    id: "biology-midterm",
    ingestionStatus: "ready",
    title: "Biology Midterm",
  },
  version: 1,
});

/**
 * Intercepts Next's same-origin `/api/viva-session/projection` route (see
 * `startSyntheticAgent`'s doc comment for why the real route can never
 * succeed against this harness's in-memory agent) and fulfills it with
 * `SYNTHETIC_SESSION_PROJECTION_FIXTURE`, merged with `overrides.session.id`
 * when the caller names a specific session id via `syntheticSessionUrl`.
 * Must be called before the page navigates to `/session`.
 *
 * @param {import("playwright").Page} page
 * @param {{ sessionId?: string }} [options]
 */
export async function routeSyntheticSessionProjection(page, { sessionId } = {}) {
  const fixture = sessionId
    ? {
        ...SYNTHETIC_SESSION_PROJECTION_FIXTURE,
        session: { ...SYNTHETIC_SESSION_PROJECTION_FIXTURE.session, id: sessionId },
      }
    : SYNTHETIC_SESSION_PROJECTION_FIXTURE;
  await page.route("**/api/viva-session/projection*", (route) =>
    route.fulfill({
      body: JSON.stringify(fixture),
      contentType: "application/json",
      status: 200,
    }),
  );
}

/**
 * The `/session` URL matching `SYNTHETIC_SESSION_PROJECTION_FIXTURE`'s
 * identity: query-string study-set/session/user identity plus the session
 * token in the navigation fragment, mirroring the real production shape
 * (`LiveSessionPage.mounted.test.tsx`'s own `ENTRY_URL` uses the identical
 * layout). The fragment token's value is never checked by anything this
 * harness can reach unsigned — only its *presence* lets the page attempt to
 * read a credential at all.
 *
 * @param {string} baseUrl
 * @param {{ sessionId?: string }} [options]
 */
export function syntheticSessionUrl(baseUrl, { sessionId = "harness-session-1" } = {}) {
  return (
    `${baseUrl}/session?user_id=user-1&study_set_id=biology-midterm` +
    `&session_id=${encodeURIComponent(sessionId)}&view=margin` +
    "#session_token=harness-unsigned-session-token&fold=open"
  );
}

/**
 * Starts `apps/web` under `next start` on a free loopback port with a
 * sanitized environment, waits for it to answer, runs `callback({ baseUrl
 * })`, and always terminates the child afterward. Unlike
 * `withFrontendDevServer`, this never builds — it throws immediately if
 * `.next/BUILD_ID` is missing, so a caller can never silently sample a
 * stale or absent build. `frontend-performance.mjs`'s production sampling
 * mode is the only caller: dev mode compiles routes lazily on first hit, an
 * unbounded confound a per-frame budget cannot separate from real cost.
 *
 * @param {{ artifactDir: string, extraEnv?: Record<string, string> }} options
 * @param {(context: { baseUrl: string }) => Promise<unknown>} callback
 */
export async function withFrontendProductionServer({ artifactDir, extraEnv = {} }, callback) {
  const buildIdPath = path.join(appsWebDir, ".next/BUILD_ID");
  if (!existsSync(buildIdPath)) {
    throw new Error(
      `no completed production build found at ${buildIdPath} — run ` +
        '"bun run --cwd apps/web build" before a production-mode sampling run',
    );
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnLogged("next-start", nextBin, ["start", "-p", String(port)], {
    cwd: appsWebDir,
    env: sanitizedEnv(extraEnv),
    artifactDir,
  });
  try {
    await waitForHttp(`${baseUrl}/`, 120_000, "next start");
    return await callback({ baseUrl });
  } finally {
    child.stop();
    await child.exit;
  }
}

/**
 * Sets Chrome's CPU throttling rate (CDP `Emulation.setCPUThrottlingRate`)
 * for `page` — e.g. `4` for a 4x slowdown emulating low-end hardware.
 * Returns the CDP session so a caller may reset/inspect it later.
 *
 * @param {import("playwright").Page} page
 * @param {number} rate
 */
export async function setCpuThrottlingRate(page, rate) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  return cdp;
}

/**
 * Disables CSP enforcement (CDP `Page.setBypassCSP`) for `page`, entirely a
 * test-harness-side workaround — it changes nothing about what the server
 * sends or what real users' browsers enforce.
 *
 * Exists because of a real, confirmed, currently-active defect spanning two
 * files this plan does not own: `apps/web/proxy.ts` (`WEBAPI-015`)'s
 * `validatedAgentOrigin` accepts only a bare-origin
 * `NEXT_PUBLIC_VIVA_AGENT_WS_URL` (its own dedicated test,
 * `viva-security-headers.test.ts`, explicitly rejects any path-bearing
 * value, e.g. `"https://agent.example/socket"`), while
 * `apps/web/lib/viva-agent-client.ts` (Plan 10's) uses that exact same env
 * var *verbatim* as the literal WebSocket connect URL
 * (`connectVivaAgent`/`vivaAgentWsUrl`, whose own hardcoded default is
 * `"ws://127.0.0.1:4318/ws"` — the `/ws` path is load-bearing, since nothing
 * appends it later). No value of that env var can satisfy both: a bare
 * origin reaches the wrong path, and a `/ws`-suffixed one satisfies the
 * client but is rejected by the CSP `connect-src` builder, so the browser's
 * own CSP blocks the connection (confirmed directly: Chromium logs
 * `"Connecting to 'ws://…' violates … connect-src"` and no agent
 * WebSocket ever opens). Separately, under a production (`next start`)
 * build, `apps/web/app/session/page.tsx` (also not owned here — see the
 * commit reverting this lane's earlier, out-of-scope fix to it) never
 * receives Next's per-request CSP nonce on any of its `<script>` tags
 * either, so the route never hydrates at all without this bypass.
 *
 * This is reported upstream (to whoever owns `proxy.ts`/
 * `viva-agent-client.ts`/`session/page.tsx`) rather than fixed here; bypassing
 * CSP in this harness's own Chromium session lets `frontend-accessibility.mjs`
 * and `frontend-performance.mjs` still mount a real, connected, fully
 * hydrated session to check the things they actually own (session landmark/
 * skip link/Transcript semantics, and representative performance sampling)
 * despite it.
 *
 * @param {import("playwright").Page} page
 */
export async function bypassCsp(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setBypassCSP", { enabled: true });
  return cdp;
}
