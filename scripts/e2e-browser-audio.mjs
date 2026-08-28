#!/usr/bin/env node
/**
 * Production-shaped browser-to-real-WebSocket proof for protocol-v5 streamed
 * microphone turns (CRIT-AUDIO-01).
 *
 * The script boots the real local Rust `agent-service` with the same
 * deterministic in-memory synthetic setup `scripts/e2e-browser.mjs` uses,
 * bundles `scripts/fixtures/e2e-browser-audio-entry.ts` for the browser, serves
 * it from a loopback origin, and drives it from a real Playwright Chromium page
 * whose `WebSocket` is the browser's own. A fake socket or a Node-only client is
 * not an adequate substitute for either case.
 *
 * Cases:
 *   --case oversized-single-chunk  negative control: one whole 2-second turn in
 *                                  a single well-shaped v5 `audio_chunk` frame
 *                                  must be rejected by the unchanged 64 KiB
 *                                  text-frame cap.
 *   (default)                      positive: 2, 10, and 45-second turns captured
 *                                  by the production capture module and queued
 *                                  by the production session controller.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEGATIVE_CONTROL_CASE = "oversized-single-chunk";
const STREAMED_TURNS_CASE = "streamed-turns";
const KNOWN_CASES = new Set([STREAMED_TURNS_CASE, NEGATIVE_CONTROL_CASE]);
const AGENT_PROVIDER = "synthetic";
const NEGATIVE_CONTROL_SECONDS = 2;
const STREAMED_TURN_SECONDS = [2, 10, 45];
const PCM16_BYTES_PER_SAMPLE = 2;
const AUDIO_SAMPLE_RATE_HZ = 24_000;
/** 20 ms production capture frames: 480 samples / 960 raw bytes each. */
const PRODUCTION_CHUNKS_PER_SECOND = 50;
const MAX_TEXT_FRAME_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 8_192;
/** Close codes that count as a positive protocol rejection (1009 Size, 1002 Protocol). */
const REJECTION_CLOSE_CODES = new Set([1002, 1009]);
const EXPECTED_OVERSIZED_ERROR = "text frame exceeds maximum size";
const EXPECTED_OVERSIZED_CLOSE_REASON = "text frame too large";

const selectedCase = parseSelectedCase(process.argv.slice(2));
// RELEASE-023: the required voice-transport matrix claims both common device
// capture rates. The rate is a CLI argument rather than an environment
// variable so no new `VIVA_*` name has to be declared in turbo.json.
const sourceSampleRateHz = parseSourceSampleRate(process.argv.slice(2));
// Fixed, gitignored output directory. It is deliberately not env-configurable:
// a new `VIVA_*` override would have to be declared in `turbo.json`, which this
// lane does not own.
const artifactDir = path.resolve(root, "artifacts/e2e-browser-audio");
const caseTimeoutMs = selectedCase === NEGATIVE_CONTROL_CASE ? 90_000 : 360_000;
const stepTimeoutMs = selectedCase === NEGATIVE_CONTROL_CASE ? 20_000 : 90_000;

const children = [];
const consoleErrors = [];
const pageErrors = [];
let browser;
let pageServer;
let bundleDir;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  const agentPort = await freePort();
  const pagePort = await freePort();
  const agentUrl = `http://127.0.0.1:${agentPort}`;
  const wsUrl = `ws://127.0.0.1:${agentPort}/ws`;
  const pageUrl = `http://127.0.0.1:${pagePort}`;

  const agent = spawnLogged(
    "agent",
    "cargo",
    ["run", "--manifest-path", "agent/Cargo.toml", "-p", "agent-service"],
    {
      VIVA_AGENT_BIND_ADDR: `127.0.0.1:${agentPort}`,
      VIVA_AGENT_PROVIDER: AGENT_PROVIDER,
      VIVA_VOICE_SESSION_TOKEN_SECRET: "",
      VIVA_VOICE_WS_ALLOWED_ORIGINS: "",
    },
  );
  const agentReadiness = await waitForHttpJson(
    `${agentUrl}/ready`,
    (json) => json?.ready === true && json?.brain?.provider === AGENT_PROVIDER,
    240_000,
    `${AGENT_PROVIDER} agent readiness`,
  );

  const session = JSON.parse(
    await readFile(
      path.join(root, "agent/fixtures/voice-protocol/v5/seeded-session-config.json"),
      "utf8",
    ),
  );

  bundleDir = await mkdtemp(path.join(os.tmpdir(), "viva-e2e-browser-audio-"));
  const bundle = await bundleBrowserEntry(bundleDir, { agentHttpUrl: agentUrl, agentWsUrl: wsUrl });
  await writeFile(path.join(bundleDir, "index.html"), harnessHtml());
  pageServer = await startStaticServer(bundleDir, pagePort);

  browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width: 1024, height: 720 } });
  await context.grantPermissions(["microphone"], { origin: pageUrl });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(pageUrl, { waitUntil: "load" });
  await page.evaluate(
    (config) => {
      window.__vivaAudioHarnessConfig = config;
    },
    {
      case: selectedCase,
      negativeControlSeconds: NEGATIVE_CONTROL_SECONDS,
      session,
      sourceSampleRateHz,
      stepTimeoutMs,
      streamedTurnSeconds: STREAMED_TURN_SECONDS,
      wsUrl,
    },
  );
  // A real click, not a synthetic one: the capture path needs genuine user
  // activation exactly like the session page does behind "Acknowledge".
  await page.click("#run");
  const observation = await waitForHarnessOutcome(page, caseTimeoutMs);

  const evaluation =
    selectedCase === NEGATIVE_CONTROL_CASE
      ? evaluateNegativeControl(observation)
      : evaluateStreamedTurns(observation);

  const result = {
    agent_provider: AGENT_PROVIDER,
    agent_url: agentUrl,
    artifact_dir: path.relative(root, artifactDir),
    browser: "playwright-chromium",
    browser_websocket: "native",
    bundle: bundle,
    case: selectedCase,
    console_errors: consoleErrors,
    evaluation,
    max_chunk_bytes: MAX_CHUNK_BYTES,
    max_text_frame_bytes: MAX_TEXT_FRAME_BYTES,
    observation,
    page_errors: pageErrors,
    page_url: pageUrl,
    source_sample_rate_hz: sourceSampleRateHz,
    store: summarizeStore(agentReadiness?.store),
    ws_url: wsUrl,
  };
  await writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(`Browser errors detected: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
  }
  if (!evaluation.passed) {
    throw new Error(`${selectedCase} did not pass: ${evaluation.failures.join(" | ")}`);
  }

  console.log(JSON.stringify(result, null, 2));
  agent?.stop();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(
    path.join(artifactDir, "failure.json"),
    `${JSON.stringify(
      {
        artifact_dir: path.relative(root, artifactDir),
        case: selectedCase,
        console_errors: consoleErrors,
        error: message,
        page_errors: pageErrors,
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  throw new Error(message);
} finally {
  await browser?.close().catch(() => {});
  await closeStaticServer(pageServer);
  for (const child of children.reverse()) child.stop();
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true }).catch(() => {});
}

/** RELEASE-023: `--source-rate <hz>` selects the device capture rate to prove. */
function parseSourceSampleRate(argv) {
  let raw = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-rate") {
      raw = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--source-rate=")) raw = arg.slice("--source-rate=".length);
  }
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 8_000 || value > 192_000) {
    throw new Error(`--source-rate must be an integer sample rate in Hz; received ${raw}`);
  }
  return value;
}

function parseSelectedCase(argv) {
  let selected = STREAMED_TURNS_CASE;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--case") {
      selected = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--case=")) {
      selected = arg.slice("--case=".length);
      continue;
    }
    if (arg === "--source-rate") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--source-rate=")) continue;
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!KNOWN_CASES.has(selected)) {
    throw new Error(`Unknown --case ${selected}; expected one of ${[...KNOWN_CASES].join(", ")}`);
  }
  return selected;
}

/**
 * The oversized single-chunk control only passes when the rejection is
 * positively observed. A timeout, a generic abnormal close (1006), or an
 * accepted turn all fail it, which is the point: it exists to catch a false
 * green produced by raising or bypassing the text/chunk cap.
 */
function evaluateNegativeControl(observation) {
  const failures = [];
  const expectedRawBytes = NEGATIVE_CONTROL_SECONDS * AUDIO_SAMPLE_RATE_HZ * PCM16_BYTES_PER_SAMPLE;
  if (observation.chunk_raw_bytes !== expectedRawBytes) {
    failures.push(
      `negative control carried ${observation.chunk_raw_bytes} raw bytes, expected ${expectedRawBytes}`,
    );
  }
  if (observation.chunk_raw_bytes <= MAX_CHUNK_BYTES) {
    failures.push("negative control chunk did not exceed the 8,192-byte chunk cap");
  }
  if (observation.chunk_frame_json_bytes <= MAX_TEXT_FRAME_BYTES) {
    failures.push(
      `negative control frame was ${observation.chunk_frame_json_bytes} bytes, which does not exceed the ${MAX_TEXT_FRAME_BYTES}-byte text cap`,
    );
  }
  if (observation.timed_out) {
    failures.push("negative control timed out instead of observing a rejection");
  }
  if (observation.audio_turn_accepted) {
    failures.push("server accepted an oversized single-chunk turn");
  }
  if (observation.server_error_message !== EXPECTED_OVERSIZED_ERROR) {
    failures.push(
      `expected server error ${JSON.stringify(EXPECTED_OVERSIZED_ERROR)}, observed ${JSON.stringify(
        observation.server_error_message,
      )}`,
    );
  }
  if (observation.server_error_echoes_payload) {
    failures.push("server protocol error echoed base64 or PCM payload material");
  }
  if (!REJECTION_CLOSE_CODES.has(observation.close_code)) {
    failures.push(
      `expected an oversized/protocol close code (${[...REJECTION_CLOSE_CODES].join(
        " or ",
      )}), observed ${observation.close_code}`,
    );
  }
  if (observation.close_reason !== EXPECTED_OVERSIZED_CLOSE_REASON) {
    failures.push(
      `expected close reason ${JSON.stringify(
        EXPECTED_OVERSIZED_CLOSE_REASON,
      )}, observed ${JSON.stringify(observation.close_reason)}`,
    );
  }
  return { case: NEGATIVE_CONTROL_CASE, failures, passed: failures.length === 0 };
}

/**
 * The positive proof: three production-shaped turns over the same real browser
 * WebSocket. Every expectation below is derived from the locked v5 contract, not
 * from whatever the harness happened to send: 20 ms production chunks mean
 * `seconds * 50` bounded chunks and `final_sequence = seconds * 50 - 1`, and the
 * synthetic examiner must report exactly `seconds * 48_000` assembled raw bytes.
 */
function evaluateStreamedTurns(observation) {
  const failures = [];
  const turns = observation.turns ?? [];
  if (turns.length !== STREAMED_TURN_SECONDS.length) {
    failures.push(`expected ${STREAMED_TURN_SECONDS.length} turns, observed ${turns.length}`);
  }
  turns.forEach((turn, index) => {
    const seconds = STREAMED_TURN_SECONDS[index];
    const label = `turn ${index + 1} (${seconds}s)`;
    const expectedSamples = seconds * AUDIO_SAMPLE_RATE_HZ;
    const expectedChunks = seconds * PRODUCTION_CHUNKS_PER_SECOND;
    const expectedRawBytes = expectedSamples * PCM16_BYTES_PER_SAMPLE;
    if (turn.seconds !== seconds) {
      failures.push(`${label}: reported ${turn.seconds}s`);
    }
    if (turn.target_samples !== expectedSamples) {
      failures.push(
        `${label}: captured target ${turn.target_samples}, expected ${expectedSamples}`,
      );
    }
    if (turn.chunks_sent !== expectedChunks) {
      failures.push(`${label}: sent ${turn.chunks_sent} chunks, expected ${expectedChunks}`);
    }
    if (turn.final_sequence !== expectedChunks - 1) {
      failures.push(
        `${label}: final_sequence ${turn.final_sequence}, expected ${expectedChunks - 1}`,
      );
    }
    if (turn.max_chunk_raw_bytes > MAX_CHUNK_BYTES) {
      failures.push(
        `${label}: a chunk carried ${turn.max_chunk_raw_bytes} raw bytes, above the ${MAX_CHUNK_BYTES}-byte cap`,
      );
    }
    if (turn.max_chunk_raw_bytes >= expectedRawBytes) {
      failures.push(`${label}: a single chunk carried the whole turn`);
    }
    if (turn.chunk_send_statuses?.socket_closed) {
      failures.push(
        `${label}: ${turn.chunk_send_statuses.socket_closed} chunks hit a closed socket`,
      );
    }
    if (turn.end_result_status !== "sent") {
      failures.push(`${label}: audio_end result was ${turn.end_result_status}, expected "sent"`);
    }
    if (turn.acceptances !== 1) {
      failures.push(
        `${label}: observed ${turn.acceptances} audio_turn_accepted frames, expected 1`,
      );
    }
    if (turn.accepted_turn_id !== turn.turn_id) {
      failures.push(
        `${label}: acceptance carried turn ${turn.accepted_turn_id}, expected ${turn.turn_id}`,
      );
    }
    if (turn.accepted_final_sequence !== expectedChunks - 1) {
      failures.push(
        `${label}: acceptance carried final_sequence ${turn.accepted_final_sequence}, expected ${
          expectedChunks - 1
        }`,
      );
    }
    if (turn.transcripts?.length !== 1) {
      failures.push(
        `${label}: observed ${turn.transcripts?.length} final transcripts, expected exactly 1`,
      );
    }
    const expectedTranscript = `received ${expectedRawBytes} PCM16 bytes`;
    if (turn.transcripts?.[0] !== expectedTranscript) {
      failures.push(
        `${label}: transcript was ${JSON.stringify(turn.transcripts?.[0])}, expected ${JSON.stringify(
          expectedTranscript,
        )}`,
      );
    }
    if (turn.evaluations !== 1) {
      failures.push(`${label}: observed ${turn.evaluations} evaluations, expected exactly 1`);
    }
    if (turn.phase_after_turn !== "correction") {
      failures.push(`${label}: phase settled at ${turn.phase_after_turn}, expected "correction"`);
    }
    if (turn.pending_submission_after_turn) {
      failures.push(`${label}: a submission was still pending after the turn resolved`);
    }
    if (turn.socket_status_after_turn !== "open") {
      failures.push(`${label}: socket status ${turn.socket_status_after_turn}, expected "open"`);
    }
    if (!turn.capture_active_after_turn) {
      failures.push(`${label}: the microphone capture did not survive the turn boundary`);
    }
  });
  if (observation.distinct_turn_ids !== turns.length) {
    failures.push(
      `expected ${turns.length} distinct turn ids, observed ${observation.distinct_turn_ids}`,
    );
  }
  if (!observation.socket_open_after_all) {
    failures.push(
      `socket was ${observation.socket_status_after_all} after all turns, expected open`,
    );
  }
  if (observation.controller_errors?.length) {
    failures.push(`controller reported errors: ${observation.controller_errors.join(" | ")}`);
  }
  if (observation.stale_events !== 0) {
    failures.push(`controller counted ${observation.stale_events} stale events, expected 0`);
  }
  if (observation.capture_target_sample_rate_hz !== AUDIO_SAMPLE_RATE_HZ) {
    failures.push(
      `capture target rate ${observation.capture_target_sample_rate_hz}, expected ${AUDIO_SAMPLE_RATE_HZ}`,
    );
  }
  return { case: STREAMED_TURNS_CASE, failures, passed: failures.length === 0 };
}

async function waitForHarnessOutcome(page, timeoutMs) {
  await page.waitForFunction(
    () =>
      window.__vivaAudioHarnessOutcome?.status !== undefined &&
      window.__vivaAudioHarnessOutcome.status !== "pending",
    undefined,
    { polling: 250, timeout: timeoutMs },
  );
  const outcome = await page.evaluate(() => window.__vivaAudioHarnessOutcome);
  if (outcome.status === "rejected") {
    throw new Error(`Browser harness failed: ${outcome.error}`);
  }
  return outcome.value;
}

async function bundleBrowserEntry(outDir, env) {
  const entry = path.join(root, "scripts/fixtures/e2e-browser-audio-entry.ts");
  const outfile = path.join(outDir, "entry.js");
  const args = [
    "build",
    entry,
    "--target=browser",
    "--outfile",
    outfile,
    "--define",
    `process.env.NEXT_PUBLIC_VIVA_AGENT_WS_URL=${JSON.stringify(env.agentWsUrl)}`,
    "--define",
    `process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL=${JSON.stringify(env.agentHttpUrl)}`,
    "--define",
    "process.env.NEXT_PUBLIC_VIVA_API_URL=undefined",
  ];
  const { code, stderr, stdout } = await runCommand("bun", args);
  if (code !== 0) {
    throw new Error(`bun build failed with ${code}: ${stderr || stdout}`);
  }
  const bytes = await readFile(outfile);
  return { entry: path.relative(root, entry), bytes: bytes.length };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

function harnessHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Viva streamed browser audio proof</title>
  </head>
  <body>
    <main>
      <h1>Viva streamed browser audio proof</h1>
      <p>This page runs the production capture and session-controller modules against the real agent WebSocket.</p>
      <button id="run" type="button">Run</button>
    </main>
    <script type="module" src="./entry.js"></script>
  </body>
</html>
`;
}

function startStaticServer(dir, port) {
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
    const resolved = path.resolve(dir, relative);
    if (!resolved.startsWith(path.resolve(dir))) {
      response.writeHead(403).end();
      return;
    }
    readFile(resolved)
      .then((bytes) => {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": contentTypes[path.extname(resolved)] ?? "application/octet-stream",
        });
        response.end(bytes);
      })
      .catch(() => {
        response.writeHead(404).end();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeStaticServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function launchChromium() {
  return await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
  });
}

function spawnLogged(name, command, args, extraEnv = {}) {
  const stdout = createWriteStream(path.join(artifactDir, `${name}.stdout.log`));
  const stderr = createWriteStream(path.join(artifactDir, `${name}.stderr.log`));
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let exited = false;
  let exitCode = null;
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code ?? signal;
  });
  const handle = {
    get exitCode() {
      return exitCode;
    },
    get exited() {
      return exited;
    },
    stop() {
      if (!exited) child.kill("SIGTERM");
      stdout.end();
      stderr.end();
    },
  };
  children.push(handle);
  return handle;
}

async function waitForHttpJson(url, predicate, timeoutMs, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    const earlyExit = children.find((child) => child.exited && child.exitCode !== 0);
    if (earlyExit) {
      throw new Error(`${label} dependency exited early with ${earlyExit.exitCode}`);
    }
    try {
      const response = await fetch(url);
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

function summarizeStore(store) {
  return {
    available: store?.available === true,
    backend: typeof store?.backend === "string" ? store.backend : null,
    durable: store?.durable === true,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("Could not allocate a free local port"));
      });
    });
  });
}
