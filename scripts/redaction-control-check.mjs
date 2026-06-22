#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addedLineViolatesRedactionAudit,
  changedFileNeedsRedactionAudit,
  forbiddenEvidenceMarkerInText,
  forbiddenStructuralFieldInText,
} from "./redaction-control.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRef = (process.env.VIVA_REDACTION_BASE_REF ?? "origin/main").trim();
const diff = readDiff(baseRef);
const violations = [];
let currentFile = null;

for (const line of diff.split("\n")) {
  const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (fileMatch) {
    currentFile = fileMatch[2];
    continue;
  }
  if (!currentFile || !changedFileNeedsRedactionAudit(currentFile)) continue;
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  const added = line.slice(1);
  if (addedLineViolatesRedactionAudit(added)) {
    const marker = forbiddenEvidenceMarkerInText(added) ?? forbiddenStructuralFieldInText(added);
    violations.push(`${currentFile}: added forbidden redaction marker ${marker}`);
  }
}

if (violations.length > 0) {
  throw new Error(
    `Changed logging/evidence code added forbidden redaction markers:\n${violations.join("\n")}`,
  );
}

console.log("Continuous redaction control check passed.");

function readDiff(base) {
  if (!base || /^0+$/.test(base)) {
    throw new Error(
      "Unable to compute redaction diff: set VIVA_REDACTION_BASE_REF to the PR base SHA or github.event.before.",
    );
  }
  try {
    return execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`, "--"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `Unable to compute redaction diff from ${base} to HEAD. Set VIVA_REDACTION_BASE_REF to the PR base SHA or github.event.before.${
        detail ? `\n${detail}` : ""
      }`,
    );
  }
}
