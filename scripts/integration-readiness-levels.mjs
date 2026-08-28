// INTEGRATION-003/004/005 — the evidence-level CLI verbs the entrypoint dispatches.
//
// The entrypoint owns the Task 1 verbs that verify the Program's already-merged history;
// the level verbs below assemble mandatory evidence over that verified manifest. They are
// registered here rather than in the entrypoint so the sibling modules A-39.3 granted this
// namespace stay independent of it and no import cycle can form: the entrypoint imports
// this module, this module imports the level modules, and the level modules import only
// `integration-readiness-shared.mjs`.
import { readdirSync, readFileSync } from "node:fs";

import { reconcileCommand } from "./integration-readiness-level1.mjs";
import { levelTwoCommand } from "./integration-readiness-level2.mjs";
import { levelThreeCommand } from "./integration-readiness-level3.mjs";
import {
  flag,
  gitIsAncestor,
  parseFlags,
  readJson,
  writeJson,
} from "./integration-readiness-shared.mjs";

/** The file and flag plumbing every level verb runs on, injected so tests can drive it. */
export const LEVEL_IO = Object.freeze({
  flag,
  gitIsAncestor,
  parseFlags,
  readdirSync,
  readFileSync,
  readJson,
  writeJson,
});

export const EVIDENCE_LEVEL_COMMANDS = Object.freeze([
  ["reconcile", (flags) => reconcileCommand(flags, LEVEL_IO)],
  ["level-2", (flags) => levelTwoCommand(flags, LEVEL_IO)],
  ["level-3", (flags) => levelThreeCommand(flags, LEVEL_IO)],
]);
