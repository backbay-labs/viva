import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "apps/web");
const nextOutput = join(webRoot, ".next");
const cacheDir = mkdtempSync(join(tmpdir(), "viva-turbo-cache-"));
const backupRoot = mkdtempSync(join(tmpdir(), "viva-build-output-backup-"));
const backupNext = join(backupRoot, ".next");
const hadNextOutput = existsSync(nextOutput);

// os.tmpdir() and the repo checkout can be different mounted devices (observed
// on this host: /tmp on one ext4 device, the repo on another), where the raw
// rename(2) syscall node:fs.renameSync wraps fails with EXDEV. Fall back to a
// copy-then-remove, exactly what the coreutils `mv` the plan's prose calls
// "rename" already does transparently across devices, so the backup/restore
// safety net for a developer's pre-existing apps/web/.next cannot silently
// fail (and, via the try/finally ordering below, delete that directory
// without ever restoring it).
function moveDirectory(source, destination) {
  try {
    renameSync(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    cpSync(source, destination, { recursive: true });
    rmSync(source, { force: true, recursive: true });
  }
}

function runBuild(extraEnv = {}) {
  const result = spawnSync(
    "bunx",
    [
      "turbo",
      "run",
      "build",
      "--filter=@viva/web",
      "--cache-dir",
      cacheDir,
      "--output-logs=full",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: "https://agent-a.invalid",
        NEXT_PUBLIC_VIVA_AGENT_WS_URL: "wss://agent-a.invalid/ws",
        NEXT_PUBLIC_VIVA_API_URL: "https://api-a.invalid",
        TURBO_TELEMETRY_DISABLED: "1",
        ...extraEnv,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function digestTree(directory) {
  const hash = createHash("sha256");
  const visit = (path) => {
    for (const entry of readdirSync(path).sort()) {
      const absolute = join(path, entry);
      const metadata = statSync(absolute);
      const relativePath = relative(directory, absolute);
      if (relativePath === "cache") continue;
      if (metadata.isDirectory()) visit(absolute);
      else {
        hash.update(relativePath);
        hash.update(readFileSync(absolute));
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function dryRunHash(publicApiUrl) {
  const result = spawnSync(
    "bunx",
    ["turbo", "run", "build", "--filter=@viva/web", "--dry-run=json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_VIVA_API_URL: publicApiUrl,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  const task = summary.tasks.find((candidate) => candidate.taskId === "@viva/web#build");
  assert.ok(task, "dry-run must include @viva/web#build");
  return task.hash;
}

try {
  if (hadNextOutput) moveDirectory(nextOutput, backupNext);

  const coldLog = runBuild();
  assert.ok(existsSync(nextOutput), "cold build must create apps/web/.next");
  assert.doesNotMatch(coldLog, /@viva\/web:build: cache hit/);
  const coldDigest = digestTree(nextOutput);

  rmSync(nextOutput, { force: true, recursive: true });
  const restoredLog = runBuild();
  assert.match(restoredLog, /@viva\/web:build: cache hit/);
  assert.ok(existsSync(nextOutput), "cache hit must restore apps/web/.next");
  assert.equal(digestTree(nextOutput), coldDigest);

  assert.notEqual(
    dryRunHash("https://api-hash-a.invalid"),
    dryRunHash("https://api-hash-b.invalid"),
    "NEXT_PUBLIC_VIVA_API_URL must change the web build hash",
  );
} finally {
  rmSync(nextOutput, { force: true, recursive: true });
  if (hadNextOutput) moveDirectory(backupNext, nextOutput);
  rmSync(cacheDir, { force: true, recursive: true });
  rmSync(backupRoot, { force: true, recursive: true });
}

console.log("Turbo cache restoration and env-hash proof passed");
