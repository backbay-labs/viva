import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/**
 * `scripts/frontend-harness.mjs` — the reusable, bounded loopback
 * process/browser lifecycle that `scripts/frontend-accessibility.mjs` and
 * `scripts/frontend-performance.mjs` mount real Next.js pages through.
 *
 * This file lands the subset of that lifecycle Task 2 needs (loopback port
 * allocation, a sanitized-env `next dev` child, Chromium launch/teardown,
 * and a minimal local library-snapshot stub so `.viva-library__*` selectors
 * have real content to render for the computed-style baseline). Task 11
 * completes it: production-mode (`next start`) support, the real synthetic
 * Rust agent-service in place of `startLibrarySnapshotStub`, CPU throttling,
 * and the fuller no-secret environment clearing a hosted gate requires.
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
  "VIVA_AGENT_HTTP_URL",
  "VIVA_AGENT_REST_BEARER_TOKEN",
  "VIVA_SESSION_ALLOWED_USER_IDS",
  "VIVA_SESSION_ALLOWED_STUDY_SET_IDS",
  "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
  "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
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

/** Launches Chromium with fake media devices, matching this repo's e2e harness. */
export async function launchChromium() {
  return chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
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
