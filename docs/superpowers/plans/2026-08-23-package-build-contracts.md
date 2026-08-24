# Package and Build Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Viva's workspace package boundaries, production-versus-fixture exports, Node-loadable runtime validation, build cache, static-export decision, React ownership, and license metadata explicit, executable, and resistant to drift.

**Spec:** Remediate the package/build obligations in `docs/superpowers/reviews/2026-08-23-architecture-consistency.md`, `docs/superpowers/reviews/2026-08-23-packages-shared.md`, `docs/superpowers/reviews/2026-08-23-architecture-review.md`, `docs/superpowers/reviews/2026-08-23-quality-and-tests-review.md`, `docs/superpowers/reviews/2026-08-23-comprehensive-review-summary.md`, and `docs/superpowers/reviews/index.md`, subject to the Plan 14 ownership and `D-06 STATIC_EXPORT` locks below.

**Architecture:** Keep `@viva/core`'s root entry point production-only, place deterministic seed data and the fake evaluator behind exact named subpaths, and publish the two owner-supplied strict validators through one exact, Node-loadable pure-ESM subpath. Enforce one-to-one parity between package exports and TypeScript path aliases without wildcard deep imports. Treat Turbo output restoration and build-time environment hashing as tested contracts; fully specify both `D-06 STATIC_EXPORT` branches but execute neither until Connor's choice is recorded. Keep `@viva/ui-web` as a deliberately small private package, with React supplied by the consuming application through a peer dependency owned by Plan 13.

**Tech Stack:** Bun 1.3.3, TypeScript 5.9, Node test runner, Turborepo 2.9, Next.js 16, Playwright 1.51, Cargo workspace metadata.

---

## Global Constraints

### Scope, decisions, and finding coverage

This is **Plan 14**. It owns only package/build contracts and must not become a back door for changing learner behavior.

| ID | Contract | Review obligation |
| --- | --- | --- |
| `PACKAGE-01` | `@viva/core` root exports production contracts and production helpers only. | ARC-08; shared-packages Minor 4 |
| `PACKAGE-02` | Fixture data and the deterministic fake evaluator use separate exact subpaths; a production browser bundle contains no fake-evaluator code. | ARC-03, ARC-08; shared-packages Minor 4 |
| `PACKAGE-03` | `packages/core/package.json` exports and `tsconfig.base.json` paths have exact parity and contain no wildcard. | architecture-consistency Minor 7 |
| `PACKAGE-04` | Turbo declares restorable build outputs and hashes every build-time public environment input; the declared build artifact (excluding `.next/cache`) can be deleted and restored byte-for-byte from local cache. | architecture-consistency Minor 4 |
| `PACKAGE-05` | `D-06 STATIC_EXPORT` is either retained with named static/server consumers plus both build/browser proofs, or removed completely. | architecture-consistency Minor 8 |
| `PACKAGE-06` | Every Rust workspace crate reports `Apache-2.0`, matching the repository license. | architecture-consistency Minor 5 |
| `PACKAGE-07` | `@viva/ui-web` remains a small private boundary and receives React from its consumer via `peerDependencies`; Plan 13 owns its manifest. | ARC-07; shared-packages Recommendation 8 |
| `PACKAGE-08` | Documentation and release claims state only the branch and package contract that actually shipped. Plan 14 ships no docs-vocabulary test: the executable status/evidence vocabulary test the ledger credits to `PACKAGE-08` is Plan 15's `scripts/public-contract.test.mjs`. | QLT-08; Plan 15 handoff |
| `PACKAGE-09` | `@viva/core/runtime-validation` is a Node 24-loadable pure-ESM subpath with exactly two callable functions—the strict Plan 04 learner-loop validator and strict Plan 05 voice-frame parser—plus Plan-04-owned runtime metadata and erased types; Plan 14 owns aggregation only, never behavior. | shared-packages Important 3 and Minor 8; Recommendation 5; Plan 12 `RELEASE-028` prerequisite |

### Ownership lock

Plan 14 may implement or modify:

- `packages/core/package.json`
- `packages/core/src/index.ts`, but only as an export surface
- `packages/core/src/runtime-validation.ts`, but only as an owner-export aggregation surface
- mechanical package decomposition files created from the current `packages/core/src/index.ts`
- `packages/core/src/package-exports.test.ts`
- `packages/core/src/index.test.ts` only to change fixture import paths
- `tsconfig.base.json`
- `turbo.json`
- `apps/web/next.config.ts`
- `agent/Cargo.toml` workspace package metadata
- package/build contract and cache-proof scripts under `scripts/`

Plan 14 must not modify:

- `packages/core/src/scheduling.ts` or its tests
- `packages/core/src/learner-loop-contract.{json,ts}`, recovery-copy code, or their tests
- `packages/core/src/agent-contract.ts`, `packages/core/src/agent-contract.test.ts`, or any Plan-05-owned adjacent test
- `packages/tokens/**`, `apps/web/app/globals.css`, or design tokens
- `packages/ui-web/package.json` or `packages/ui-web/src/**` (Plan 13 owns them)
- root `package.json`, `bun.lock`, and `agent/Cargo.lock` (Plan 12 owns release/dependency integration and lockfiles)
- `apps/web/package.json`
- `README.md`, `CONTRIBUTING.md`, deployment docs, or other public documentation (Plan 15 owns them)
- `.github/workflows/**`

### `D-06 STATIC_EXPORT` decision lock

The canonical name is **`D-06 STATIC_EXPORT`**. Authentication is `D-07`; this plan must not reuse `D-06` for auth.

`D-06 STATIC_EXPORT` is reserved for Connor. At reviewed revision `4d5d827`, no script, workflow, or deployment document sets `VIVA_STATIC_EXPORT` or `NEXT_PUBLIC_VIVA_STATIC_EXPORT`; that is evidence for Connor's decision, not authority for an implementation worker to choose deletion.

- Stop before Task 6 until the coordinator records Connor's exact **retain** or **delete** choice.
- If Connor chooses retain, the decision record must name the actual static consumer and the separate server BFF; generic future consumers are insufficient.
- After the recorded choice, execute exactly one branch. Do not merge a state in which some static flags remain but the build/browser gate does not.

### Cross-plan handoffs that block Plan 14 closure

| Owner | Required delivery |
| --- | --- |
| Plan 04 | Before `PACKAGE-09` can turn GREEN, land the strict `validateLearnerLoopContract(value: unknown): LearnerLoopContract` implementation and its behavioral tests. Keep `learner-loop-contract.ts` directly loadable by Node 24 ESM: its relative TypeScript import uses `./agent-contract.ts`, and its JSON import uses `with { type: "json" }`. Also land `study-projection-contract.ts` with `AuthenticatedStudyProjectionV1` and `validateAuthenticatedStudyProjectionV1(value: unknown)`; Plan 14 adds only that module's explicit production-root re-export. Plan 04 Task `LEARN-006A` must also have landed the exported `VIVA_LEARNER_LOOP_TERMINAL_REASONS` array in `learner-loop-contract.ts`; it does not exist at baseline, and Plan 14 only re-exports it. Plan 14 neither edits nor stages either behavioral module or its tests. |
| Plan 05 | Before `PACKAGE-09` can turn GREEN, land the strict `parseVivaServerFrame(value: unknown): VivaServerFrame` implementation and behavioral tests. In the same owner lane, change `packages/core/src/agent-contract.test.ts`'s seed-data import from `./index` to `./fixtures`; Plan 14 may run that test but never modifies or stages it. |
| Plan 10 | Migrate its fixture imports, including `LiveSessionPage.tsx`, to `@viva/core/fixtures` without behavior changes. For `D-06` Branch A, preserve and browser-test direct-agent routing; for Branch B, remove `viva-agent-client.ts` static flag reads, `vivaStaticExportEnabled`, the proxy bypass, and their tests. |
| Plan 13 | Keep `@viva/ui-web` deliberately small/private rather than claiming a general design system. Own its exact `"./styles.css": "./src/styles.css"` export and `"@viva/tokens": "workspace:*"` stylesheet dependency; move `react` from regular dependencies to `peerDependencies` with `"^19.2.3"`; add `react: "19.2.3"` to `devDependencies`; and keep the app's direct React dependency. Migrate Plan-13-owned fixture imports. For `D-06` Branch A, own static landing/library/browser consumer behavior; for Branch B, remove `staticExport` options and tests from `viva-library.ts`, `viva-library.test.ts`, `app/page.tsx`, and static-only landing tests. Do not broaden the component surface until a second real consumer exists. |
| Plan 11 | Own `apps/web/proxy.ts` and `apps/web/lib/viva-security-headers.test.ts`. Its server BFF requires no `output: "export"`, no static-only routing flags, preserved API/proxy routes, and combined CSP/browser proof. Plan 11 may merge after its owner-local route/header tests and typecheck against Phase 14A's additive `@viva/core` export surface (which includes the study-projection root re-export once Plan 04's module lands), not the post-removal root; it does not wait for Task 6. Branch A blocks Plan 15's frozen-tree release acceptance—not the Plan 11 owner merge—unless Connor names a separate server BFF for those routes. |
| Plan 12 | Own root/app manifests and every lockfile consequence. Add root devDependency `"@viva/core": "workspace:*"` so root Node release scripts can resolve `@viva/core/runtime-validation`. Add exact app devDependencies `"happy-dom": "20.11.6"` and `"@happy-dom/global-registrator": "20.11.6"` before Plan 10 creates its DOM setup/mounted tests. Regenerate `bun.lock` with Bun 1.3.3. At minimum add root script `build:cache:prove`; Branch A also adds `build:static` and `e2e:static`, while Branch B removes those two static scripts if present. The root `@viva/core` devDependency, the `build:cache:prove` script, and the regenerated `bun.lock` arrive via Plan 12's early additive root-manifest commit — permitted by program Section 4's root `package.json` row ("Plan 12 may use an early additive dependency commit and a later rebased release-integration commit") — and that commit must be merged to integration before Plan 14's GREEN verification runs (Task 3 Step 5, Task 4 Step 5, Task 7 Step 1). Plan 12's merge-order constraint 9 and its Task 14 Step 4A2 now carry this root-manifest commit as a permitted early `12A` commit. |
| Plan 15 | Update package, build-cache, UI-boundary, license, and static-export claims after the selected branch and exact combined SHA are known. |

Plan 14 may add failing contract tests for these handoffs, but it must not edit the owner files. Plan 14 is not complete until the combined tree passes those tests.

### Phase split required by the integration DAG

Program Section 6 defines merge node `14a` as additive-only ("adds fixture/package exports without removing the old root surface; consumers migrate their imports") and `14b` as the removal plus the selected `D-06`/build contract. This plan's tasks split accordingly:

- **Phase 14A (merge node `14a`) — additive only:** Task 1's failing surface test; Task 2 Steps 1–2, which create `fixtures.ts`, `testing/fake-evaluator.ts`, and `runtime-validation.ts`, add the three new subpath entries to `packages/core/package.json` `exports`, and install the exact `tsconfig.base.json` paths (dropping the unused `@viva/core/*` wildcard) while `packages/core/src/index.ts` keeps its full export surface; and Tasks 3–5's lane-local contract tests, cache contracts, and license metadata, whose handoff-dependent assertions stay RED until the named owner commits land. Plan 11 typechecks against this Phase-14A additive export surface — which already includes the study-projection root re-export once Plan 04's module is merged (Task 2 Step 1's second additive commit) — not against the post-removal root. Because `runtime-validation.ts` re-exports Plan 04's `LEARN-006A` constant `VIVA_LEARNER_LOOP_TERMINAL_REASONS` (absent at baseline), the coordinator merges `14a` to integration only after Plan 04's `study-projection-contract.ts` module and that `LEARN-006A` export are on integration; both precede Plans 11/10 in the DAG, so this delays nothing.
- **Phase 14B (merge node `14b`) — removal and selected branch:** Task 2 Steps 3–10 (the `git mv` rename, the production-only root, migration verification, the GREEN typecheck, and the split commit) plus Task 6. Task 2 Steps 3–10 execute only on a lane rebased onto an integration tip that already contains the Plan 05 `agent-contract.test.ts` migration and the Plan 10/13 fixture-import migrations (`LiveSessionPage.tsx`, `viva-display.test.ts`, `use-viva-agent-session.test.ts`). Task 6 executes only after Connor records `D-06 STATIC_EXPORT` and after the Plan 10/11/13 owner commits needed by the selected branch are available. The server build, CSP/API browser proof, and selected static proof are reverse handoffs to Plan 15's frozen-tree acceptance, not prerequisites for the Plan 11 owner merge.

## File structure after the shared package split

| File | Responsibility |
| --- | --- |
| `packages/core/src/index.ts` | Production-only public entry point: protocol, learner-loop, recovery-copy, scheduling, production study-set types/helpers. No fixture values or fake evaluator. |
| `packages/core/src/study-set.ts` | Mechanical home for the current study-set types/helpers and fixture implementation while behavior-preserving extraction is reviewed. No contract/scheduler edits. |
| `packages/core/src/fixtures.ts` | Exact fixture-only entry point exposing `sampleQuestion`, `sourceConflictExample`, and `seedStudySets`. |
| `packages/core/src/testing/fake-evaluator.ts` | Exact test-only entry point exposing `evaluateAnswer` and `buildSessionRecap`. |
| `packages/core/src/runtime-validation.ts` | Export-only aggregation of Plan 04's `validateLearnerLoopContract` and Plan 05's `parseVivaServerFrame`; no wrapper, schema, catch, cast, or alternate behavior. |
| `packages/core/src/package-exports.test.ts` | Runtime proof that root/fixture/testing surfaces do not overlap and the runtime-validation surface has exactly two callable exports. |
| `scripts/package-build-contract.test.mjs` | Metadata, alias parity, bundle isolation, Turbo, UI-peer handoff, static-decision, and license assertions. |
| `scripts/prove-turbo-cache-restoration.mjs` | Destructive-only-to-generated-output proof that a deleted declared artifact is restored byte-for-byte from an isolated local Turbo cache. |
| `scripts/static-export-browser-gate.mjs` | Branch-A-only static artifact server and Playwright navigation gate. |

The initial move to `study-set.ts` is intentionally mechanical. It avoids mixing this package-boundary repair with scheduling, learner-loop, or agent-contract behavior. A later domain plan may split production study-set modeling further, but this plan neither requires nor claims that work.

### Task 1: Lock the public, fixture, fake-evaluator, and runtime-validation surfaces (`PACKAGE-01`, `PACKAGE-02`, `PACKAGE-09`)

**Files:**

- Create: `packages/core/src/package-exports.test.ts`
- Test: `packages/core/src/package-exports.test.ts`

- [ ] **Step 1: Write the failing runtime surface test**

Create `packages/core/src/package-exports.test.ts` with exactly:

```ts
import { describe, expect, test } from "bun:test";
import { parseVivaServerFrame as ownerParseVivaServerFrame } from "./agent-contract";
import * as fixtures from "./fixtures";
import * as publicCore from "./index";
import { validateLearnerLoopContract as ownerValidateLearnerLoopContract } from "./learner-loop-contract";
import * as runtimeValidation from "./runtime-validation";
import * as fakeEvaluator from "./testing/fake-evaluator";

const fixtureOnlyExports = ["sampleQuestion", "seedStudySets", "sourceConflictExample"] as const;
const fakeEvaluatorOnlyExports = ["buildSessionRecap", "evaluateAnswer"] as const;
const runtimeValidationValueExports = [
  "VIVA_LEARNER_LOOP_CONTRACT",
  "VIVA_LEARNER_LOOP_EVIDENCE_FIELDS",
  "VIVA_LEARNER_LOOP_MAX_TURN_MS",
  "VIVA_LEARNER_LOOP_TERMINAL_REASONS",
  "VIVA_PRE_LOOP_TERMINAL_REASONS",
  "VIVA_RUNTIME_COPY_CAUSES",
  "parseVivaServerFrame",
  "validateLearnerLoopContract",
] as const;

describe("@viva/core package surfaces", () => {
  test("keeps fixture and fake-evaluator values out of the production root", () => {
    for (const exportName of [...fixtureOnlyExports, ...fakeEvaluatorOnlyExports]) {
      expect(publicCore).not.toHaveProperty(exportName);
    }
    expect(typeof publicCore.validateAuthenticatedStudyProjectionV1).toBe("function");
  });

  test("exposes only deterministic data from the fixture entry", () => {
    expect(Object.keys(fixtures).sort()).toEqual([...fixtureOnlyExports].sort());
    expect(fixtures.seedStudySets[0]?.id).toBe("biology-midterm");
  });

  test("exposes the deterministic evaluator only from the testing entry", () => {
    expect(Object.keys(fakeEvaluator).sort()).toEqual([...fakeEvaluatorOnlyExports].sort());
    expect(fakeEvaluator.evaluateAnswer("36 ATP").correctionKind).toBe(
      "course-specific discrepancy",
    );
  });

  test("aggregates owner validators without wrappers or extra runtime values", () => {
    expect(Object.keys(runtimeValidation).sort()).toEqual(
      [...runtimeValidationValueExports].sort(),
    );
    expect(runtimeValidation.parseVivaServerFrame).toBe(ownerParseVivaServerFrame);
    expect(runtimeValidation.validateLearnerLoopContract).toBe(ownerValidateLearnerLoopContract);
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
bun test packages/core/src/package-exports.test.ts
```

Expected: FAIL before test execution because `./fixtures`, `./testing/fake-evaluator`, and `./runtime-validation` do not exist. This is the required RED proof.

- [ ] **Step 3: Commit only the failing contract test**

```bash
git add packages/core/src/package-exports.test.ts
git commit -m "test(core): lock package export boundaries"
```

### Task 2: Create exact production, fixture, testing, and runtime-validation entry points (`PACKAGE-01`, `PACKAGE-02`, `PACKAGE-03`, `PACKAGE-09`)

**Files:**

- Rename: `packages/core/src/index.ts` → `packages/core/src/study-set.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/fixtures.ts`
- Create: `packages/core/src/testing/fake-evaluator.ts`
- Create: `packages/core/src/runtime-validation.ts`
- Modify: `packages/core/package.json:6-12`
- Modify: `tsconfig.base.json:16-20`
- Modify: `packages/core/src/index.test.ts:1-11`
- Handoff modify (Plan 04): `packages/core/src/learner-loop-contract.ts`
- Handoff create (Plan 04): `packages/core/src/study-projection-contract.ts`, `packages/core/src/study-projection-contract.test.ts`
- Handoff modify (Plan 05): `packages/core/src/agent-contract.test.ts:22`
- Handoff modify (Plan 12): `package.json`, `bun.lock`
- Test: `packages/core/src/package-exports.test.ts`

- [ ] **Step 1: Publish the additive Phase-14A entry points and manifests before any consumer migrates**

Create `packages/core/src/fixtures.ts` while the existing root remains intact:

```ts
export { sampleQuestion, seedStudySets, sourceConflictExample } from "./index";
```

Create `packages/core/src/testing/fake-evaluator.ts` as the same kind of additive bridge:

```ts
export { buildSessionRecap, evaluateAnswer } from "../index";
```

Create `packages/core/src/runtime-validation.ts` with exactly these owner-function re-exports, owner constants, and erased owner types:

```ts
export { parseVivaServerFrame } from "./agent-contract.ts";

export {
  validateLearnerLoopContract,
  VIVA_LEARNER_LOOP_CONTRACT,
  VIVA_LEARNER_LOOP_EVIDENCE_FIELDS,
  VIVA_LEARNER_LOOP_MAX_TURN_MS,
  VIVA_LEARNER_LOOP_TERMINAL_REASONS,
  VIVA_PRE_LOOP_TERMINAL_REASONS,
  VIVA_RUNTIME_COPY_CAUSES,
} from "./learner-loop-contract.ts";

export type {
  LearnerLoopAuthority,
  LearnerLoopContract,
  LearnerLoopCopy,
  LearnerLoopEvidenceField,
  LearnerLoopResolutionKind,
  LearnerLoopState,
  LearnerLoopTerminalReason,
  RuntimeCopyCause,
  VivaPreLoopTerminalReason,
} from "./learner-loop-contract.ts";
```

This file contains no function body, schema, error translation, catch, cast, or value transform. The explicit `.ts` specifiers are required for native Node ESM resolution; Plan 04/05 retain the only behavioral implementations. The `VIVA_LEARNER_LOOP_TERMINAL_REASONS` constant does not exist at baseline: Plan 04 Task `LEARN-006A` creates it in `learner-loop-contract.ts`, and Plan 14 only re-exports it. Author this file in the lane immediately, but include it in the additive commit only once that Plan 04 export is available on the lane's base — before then the re-export cannot typecheck.

Replace `packages/core/package.json` with:

```json
{
  "name": "@viva/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./fixtures": "./src/fixtures.ts",
    "./runtime-validation": "./src/runtime-validation.ts",
    "./testing/fake-evaluator": "./src/testing/fake-evaluator.ts"
  },
  "scripts": {
    "build": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test src/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ts-fsrs": "^5.4.1"
  },
  "devDependencies": {
    "typescript": "^5.9.3"
  }
}
```

Add this compiler option next to `verbatimModuleSyntax` in `tsconfig.base.json`:

```json
"allowImportingTsExtensions": true,
```

Every workspace TypeScript build is `--noEmit`; this option allows the explicit Node-ESM `.ts` specifiers without creating a second compiled-path contract. Then replace only `compilerOptions.paths` with:

```json
"paths": {
  "@viva/core": ["packages/core/src/index.ts"],
  "@viva/core/fixtures": ["packages/core/src/fixtures.ts"],
  "@viva/core/runtime-validation": ["packages/core/src/runtime-validation.ts"],
  "@viva/core/testing/fake-evaluator": ["packages/core/src/testing/fake-evaluator.ts"],
  "@viva/tokens": ["packages/tokens/src/index.ts"],
  "@viva/ui-web": ["packages/ui-web/src/index.tsx"]
}
```

There must be no `@viva/core/*` entry and no `"./*"` package export; no code in the tree uses the dropped wildcard.

Run the unchanged Plan-05-owned test as a compatibility baseline while the root is still intact:

```bash
bun test packages/core/src/agent-contract.test.ts
```

Expected: PASS. Commit the additive surface; the package-boundary test deliberately remains RED until the full split:

```bash
git add packages/core/src/fixtures.ts packages/core/src/testing/fake-evaluator.ts packages/core/src/runtime-validation.ts packages/core/package.json tsconfig.base.json
git commit -m "feat(core): publish fixture migration entry"
```

If Plan 04's `LEARN-006A` export is not yet on the lane's base, omit `packages/core/src/runtime-validation.ts` from this commit and include it in the second additive commit below instead.

Once Plan 04's `study-projection-contract.ts` (`LEARN-008`) is present on the lane's base, append the production root re-export Plan 11 consumes to the still-intact `packages/core/src/index.ts` as a second additive commit:

```ts
export * from "./study-projection-contract";
```

This is the Phase-14A root surface Plan 11 typechecks against; it adds the study-projection contract without removing anything.

- [ ] **Step 2: Receive the Plan 05 test-import commit**

After the additive bridge commit is available, Plan 05 alone replaces this import in `packages/core/src/agent-contract.test.ts`:

```ts
import { seedStudySets } from "./index";
```

with:

```ts
import { seedStudySets } from "./fixtures";
```

Plan 05 runs `bun test packages/core/src/agent-contract.test.ts`, stages only `packages/core/src/agent-contract.test.ts`, and commits it as `test(voice): isolate contract fixtures` under the Plan 05 lane. That owner action is specified in Plan 05 and is not executed from this lane.

Expected: PASS and a Plan 05 commit whose only migration path is `packages/core/src/agent-contract.test.ts`. Plan 14 records that owner commit, never edits/stages the file, and only then removes root compatibility exports.

Verify that file-scoped owner commit on the integration branch before proceeding. Qualify `git log` with the integration branch name — an unqualified `git log` searches only the lane worktree's own history and reports a false negative until the lane rebases:

```bash
git fetch --all --prune
plan05_fixture_commit="$(git log review-remediation/integration -1 --format=%H --grep='^test(voice): isolate contract fixtures$')"
test -n "$plan05_fixture_commit"
test "$(git show --format= --name-only "$plan05_fixture_commit" | sed '/^$/d' | sort -u)" = "packages/core/src/agent-contract.test.ts"
```

Expected: exit 0. This command verifies the Plan 05 commit; it does not stage or amend it.

Steps 1–2 are Phase 14A (merge node `14a`). Steps 3–10 are Phase 14B (merge node `14b`): they execute only on a lane rebased onto an integration tip that already contains the Plan 05 `agent-contract.test.ts` migration and the Plan 10/13 fixture-import migrations (`LiveSessionPage.tsx`, `viva-display.test.ts`, `use-viva-agent-session.test.ts`).

- [ ] **Step 3: Mechanically rename the current implementation module**

Run:

```bash
git mv packages/core/src/index.ts packages/core/src/study-set.ts
```

Delete only the five leading re-export lines from `packages/core/src/study-set.ts` — the four baseline lines plus the `study-projection-contract` line that Task 2 Step 1's second Phase-14A additive commit appended (present here because Steps 3–10 run only after that commit and Plan 04's module are on the lane's base):

```ts
export * from "./agent-contract";
export * from "./learner-loop-contract";
export * from "./learner-recovery-copy";
export * from "./scheduling";
export * from "./study-projection-contract";
```

Do not change any remaining type, constant, function body, string, or fixture value during this move. Verify that the move is mechanical apart from those five lines — run this after the `git mv` and before Step 4 recreates `index.ts`, and diff against `HEAD` so the staged rename and the unstaged line deletions appear together:

```bash
git diff HEAD --find-renames=90% -- packages/core/src/index.ts packages/core/src/study-set.ts
```

Expected: one rename plus deletion of the five re-export lines; no learner or evaluator behavior diff.

- [ ] **Step 4: Create the production-only root entry point**

Create `packages/core/src/index.ts` with exactly:

```ts
export * from "./agent-contract";
export * from "./learner-loop-contract";
export * from "./learner-recovery-copy";
export * from "./scheduling";
export * from "./study-projection-contract";

export {
  DEFAULT_TRUSTED_AGENT_STUDY_SET_ID,
  agentStudySetReadiness,
  createStudySetPreview,
  generatedHomeCards,
  studySetFromPasteIngestionResponse,
} from "./study-set";

export type {
  AgentStudySetReadiness,
  AnswerEvaluation,
  Concept,
  ConceptStatus,
  CorrectionKind,
  EvaluationLabel,
  GeneratedCard,
  PasteIngestionConcept,
  PasteIngestionDocument,
  PasteIngestionQuestion,
  PasteIngestionResponse,
  PasteIngestionSourceSpan,
  PasteIngestionStudySet,
  SessionPhase,
  SessionQuestion,
  SessionRecap,
  SourceReference,
  StudyMode,
  StudySet,
  StudySetIngestionStatus,
  UploadedDocument,
} from "./study-set";
```

The `study-projection-contract` re-export is the Plan 04 `LEARN-008` handoff required by Plan 11; do not omit or rename it. It compiles only once Plan 04's `LEARN-008` module is present in the tree — a prerequisite Step 8 already imposes before GREEN. If another approved production module lands before execution, preserve its explicit root re-export too. Do not use `export * from "./study-set"`, because that would re-expose the fixture and evaluator values this task removes.

- [ ] **Step 5: Point the fixture and testing bridges at the mechanical module**

Replace `packages/core/src/fixtures.ts` with:

```ts
export { sampleQuestion, seedStudySets, sourceConflictExample } from "./study-set";
```

Replace `packages/core/src/testing/fake-evaluator.ts` with:

```ts
export { buildSessionRecap, evaluateAnswer } from "../study-set";
```

`packages/core/src/runtime-validation.ts` already exists from Step 1's additive commit and re-exports only Plan 04/05 owner modules; the rename does not touch it.

- [ ] **Step 6: Verify the exact wildcard-free manifests survived the split**

`packages/core/package.json` and `tsconfig.base.json` already carry their exact final content from Step 1's additive commit; the split renames modules without touching either manifest. Confirm nothing reintroduced a wildcard:

```bash
rg -n '"@viva/core/\*"|"\./\*"' tsconfig.base.json packages/core/package.json
```

Expected: no matches.

- [ ] **Step 7: Move the Plan-14-owned test imports and receive application handoffs**

In `packages/core/src/index.test.ts`, keep production imports from `./index`, import fixture data from `./fixtures`, and import fake evaluation from `./testing/fake-evaluator`:

```ts
import { describe, expect, test } from "bun:test";
import {
  agentStudySetReadiness,
  createStudySetPreview,
  generatedHomeCards,
  type PasteIngestionResponse,
  studySetFromPasteIngestionResponse,
} from "./index";
import { seedStudySets } from "./fixtures";
import { buildSessionRecap, evaluateAnswer } from "./testing/fake-evaluator";
```

- [ ] **Step 8: Land the validator and Node-resolution handoffs before claiming GREEN**

Plan 04 must first land its strict unknown-input validator and make its owned module native-Node-loadable with exactly:

```ts
} from "./agent-contract.ts";
import contractData from "./learner-loop-contract.json" with { type: "json" };
```

It calls `validateLearnerLoopContract(contractData)` without an unchecked cast and owns all behavioral RED/GREEN tests. Plan 04 Task `LEARN-006A` must also have landed the exported `VIVA_LEARNER_LOOP_TERMINAL_REASONS` array in `learner-loop-contract.ts`; it does not exist at baseline, and Plan 14 only re-exports it. Plan 05 must also have landed strict, redaction-safe unknown-key reconstruction for `parseVivaServerFrame(value: unknown)` in a pure-ESM module with no Node builtin, environment, filesystem, browser-global, root-entry, or fixture import. Plan 12 must add root devDependency `"@viva/core": "workspace:*"` and regenerate `bun.lock` with Bun 1.3.3 (via its early additive root-manifest commit — see the Plan 12 handoff row) so root Node scripts receive a workspace link.

The combined tree must contain these import-only migrations:

```ts
import type { SessionRecap } from "@viva/core";
import { seedStudySets } from "@viva/core/fixtures";
```

Apply that split in `apps/web/components/session/LiveSessionPage.tsx`. Test-only consumers in `apps/web/lib/viva-display.test.ts` and `apps/web/lib/use-viva-agent-session.test.ts` must likewise import `seedStudySets` from `@viva/core/fixtures`. The owning plans make these edits; Plan 14 only verifies them.

Run (the multiline form is required: `viva-display.test.ts` and `use-viva-agent-session.test.ts` import `seedStudySets` inside braces-spanning imports that a line-oriented grep misses):

```bash
rg -nU --multiline-dotall 'import[^;]*\b(sampleQuestion|seedStudySets|sourceConflictExample|evaluateAnswer|buildSessionRecap)\b[^;]*from "@viva/core";' apps packages
```

Expected: no matches (exit 1).

Confirm Plan 14 has not staged the Plan 05 test:

```bash
test -z "$(git diff --cached --name-only -- packages/core/src/agent-contract.test.ts)"
```

Expected: exit 0 with no output.

- [ ] **Step 9: Run the focused tests and typecheck to verify GREEN**

Run:

```bash
bun test packages/core/src/package-exports.test.ts packages/core/src/index.test.ts packages/core/src/agent-contract.test.ts
bun run typecheck
```

Expected: all focused tests PASS and Turbo reports all TypeScript workspace typechecks successful.

- [ ] **Step 10: Commit the split without unrelated owner files**

```bash
git add packages/core/package.json packages/core/src/index.ts packages/core/src/study-set.ts packages/core/src/fixtures.ts packages/core/src/testing/fake-evaluator.ts packages/core/src/runtime-validation.ts packages/core/src/index.test.ts tsconfig.base.json
test -z "$(git diff --cached --name-only -- packages/core/src/agent-contract.test.ts)"
git commit -m "refactor(core): separate production and fixture exports"
```

Do not stage Plan 04, Plan 05, Plan 10, Plan 12, Plan 13, or `LiveSessionPage.tsx` owner changes in this commit.

### Task 3: Prove metadata parity, Node ESM loading, and production bundle isolation (`PACKAGE-02`, `PACKAGE-03`, `PACKAGE-07`, `PACKAGE-09`)

**Files:**

- Create: `scripts/package-build-contract.test.mjs`
- Test: `scripts/package-build-contract.test.mjs`
- Handoff modify (Plan 13): `packages/ui-web/package.json`
- Handoff modify (Plan 12): `package.json`, `apps/web/package.json`, `bun.lock`

- [ ] **Step 1: Write the failing metadata and bundle contract test**

Create `scripts/package-build-contract.test.mjs` with exactly:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

function build(entry, outfile) {
  const result = spawnSync(
    "bun",
    ["build", entry, "--target=browser", "--minify", "--outfile", outfile],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("@viva/core exports have exact TypeScript-path parity and no wildcard", async () => {
  const corePackage = await readJson("packages/core/package.json");
  const tsconfig = await readJson("tsconfig.base.json");
  const expectedExports = {
    ".": "./src/index.ts",
    "./fixtures": "./src/fixtures.ts",
    "./runtime-validation": "./src/runtime-validation.ts",
    "./testing/fake-evaluator": "./src/testing/fake-evaluator.ts",
  };
  const expectedPaths = {
    "@viva/core": ["packages/core/src/index.ts"],
    "@viva/core/fixtures": ["packages/core/src/fixtures.ts"],
    "@viva/core/runtime-validation": ["packages/core/src/runtime-validation.ts"],
    "@viva/core/testing/fake-evaluator": ["packages/core/src/testing/fake-evaluator.ts"],
  };

  assert.deepEqual(corePackage.exports, expectedExports);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(tsconfig.compilerOptions.paths).filter(([key]) =>
        key.startsWith("@viva/core"),
      ),
    ),
    expectedPaths,
  );
  assert.equal(
    Object.keys(corePackage.exports).some((key) => key.includes("*")),
    false,
  );
  assert.equal(
    Object.keys(tsconfig.compilerOptions.paths).some(
      (key) => key.startsWith("@viva/core") && key.includes("*"),
    ),
    false,
  );
});

test("@viva/core/runtime-validation is native Node pure ESM", () => {
  const probe = [
    'const runtimeValidation = await import("@viva/core/runtime-validation");',
    "const actual = Object.keys(runtimeValidation).sort();",
    "const expected = [",
    '  "VIVA_LEARNER_LOOP_CONTRACT",',
    '  "VIVA_LEARNER_LOOP_EVIDENCE_FIELDS",',
    '  "VIVA_LEARNER_LOOP_MAX_TURN_MS",',
    '  "VIVA_LEARNER_LOOP_TERMINAL_REASONS",',
    '  "VIVA_PRE_LOOP_TERMINAL_REASONS",',
    '  "VIVA_RUNTIME_COPY_CAUSES",',
    '  "parseVivaServerFrame",',
    '  "validateLearnerLoopContract",',
    "].sort();",
    "if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(2);",
    'if (typeof runtimeValidation.parseVivaServerFrame !== "function") process.exit(3);',
    'if (typeof runtimeValidation.validateLearnerLoopContract !== "function") process.exit(4);',
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", probe],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("production browser entry excludes the deterministic fake evaluator", async (t) => {
  const tempDir = await mkdtemp(join(root, "apps/web/.package-build-contract-"));
  t.after(async () => rm(tempDir, { force: true, recursive: true }));

  const productionEntry = join(tempDir, "production-entry.ts");
  const productionBundle = join(tempDir, "production-bundle.js");
  const negativeControlEntry = join(tempDir, "fake-evaluator-entry.ts");
  const negativeControlBundle = join(tempDir, "fake-evaluator-bundle.js");

  await writeFile(
    productionEntry,
    [
      'import { createStudySetPreview } from "@viva/core";',
      'import { seedStudySets } from "@viva/core/fixtures";',
      "globalThis.__vivaPackageContract = [",
      '  createStudySetPreview({ pastedText: "cellular respiration" }).id,',
      "  seedStudySets[0]?.id,",
      "];",
    ].join("\n"),
  );
  await writeFile(
    negativeControlEntry,
    [
      'import { evaluateAnswer } from "@viva/core/testing/fake-evaluator";',
      'globalThis.__vivaFakeEvaluation = evaluateAnswer("36 ATP").retryPrompt;',
    ].join("\n"),
  );

  build(productionEntry, productionBundle);
  build(negativeControlEntry, negativeControlBundle);

  const production = await readFile(productionBundle, "utf8");
  const negativeControl = await readFile(negativeControlBundle, "utf8");
  const fakeOnlyText = "Try again using the phrase 'shuttle system'.";

  assert.doesNotMatch(production, new RegExp(fakeOnlyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(negativeControl, new RegExp(fakeOnlyText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("@viva/ui-web receives React from its consumer", async () => {
  const uiPackage = await readJson("packages/ui-web/package.json");
  assert.equal(uiPackage.private, true);
  assert.deepEqual(uiPackage.exports, {
    ".": "./src/index.tsx",
    "./styles.css": "./src/styles.css",
  });
  assert.equal(uiPackage.dependencies?.["@viva/tokens"], "workspace:*");
  assert.equal(uiPackage.dependencies?.react, undefined);
  assert.equal(uiPackage.peerDependencies?.react, "^19.2.3");
  assert.equal(uiPackage.devDependencies?.react, "19.2.3");
});

test("mounted web tests use one exact DOM implementation", async () => {
  const webPackage = await readJson("apps/web/package.json");
  assert.equal(webPackage.devDependencies?.["happy-dom"], "20.11.6");
  assert.equal(webPackage.devDependencies?.["@happy-dom/global-registrator"], "20.11.6");
});
```

- [ ] **Step 2: Run the test to verify the handoff is RED**

Run:

```bash
node --test scripts/package-build-contract.test.mjs
```

Expected before the owner handoffs land: export parity and bundle isolation PASS — the bundle test's temp entries deliberately live under `apps/web/` so `bun build` resolves `@viva/core` through `apps/web/node_modules` before Plan 12's root `@viva/core` devDependency lands (the repository root has no `node_modules/@viva` link at baseline); the native Node test FAILS because root Node resolution and/or owner-module ESM compatibility is absent; the UI package test FAILS because the stylesheet export/token dependency/React peer disposition is absent; and the mounted-test dependency test FAILS because Plan 12 has not added both exact packages.

- [ ] **Step 3: Receive the Plan 12 root Node-resolution handoff**

This handoff arrives via Plan 12's early additive root-manifest commit — permitted by program Section 4's root `package.json` row — which must be merged to integration before Step 5's GREEN run; it is not deferred to Plan 12's final `12B` release merge. Plan 12 adds exactly this entry to root `package.json` `devDependencies`:

```json
"@viva/core": "workspace:*"
```

It also adds exactly these entries to `apps/web/package.json` `devDependencies`:

```json
"@happy-dom/global-registrator": "20.11.6",
"happy-dom": "20.11.6"
```

Plan 12 runs Bun 1.3.3 to update `bun.lock`, owns all three files, and proves a clean install creates the root workspace link and exact DOM packages:

```bash
bun install --frozen-lockfile
node --experimental-strip-types --input-type=module --eval 'const m = await import("@viva/core/runtime-validation"); if (typeof m.validateLearnerLoopContract !== "function" || typeof m.parseVivaServerFrame !== "function") process.exit(1)'
test "$(bun pm ls --all | rg -c '(@happy-dom/global-registrator|happy-dom)@20\.11\.6')" -eq 2
```

Plan 14 does not edit or stage either root file.

- [ ] **Step 4: Receive the Plan 13 peer-dependency change**

Plan 13 must produce this manifest fragment in `packages/ui-web/package.json`:

```json
"exports": {
  ".": "./src/index.tsx",
  "./styles.css": "./src/styles.css"
},
"dependencies": {
  "@viva/tokens": "workspace:*"
},
"peerDependencies": {
  "react": "^19.2.3"
},
"devDependencies": {
  "@types/react": "^19",
  "@types/react-dom": "^19",
  "react": "19.2.3",
  "react-dom": "19.2.3",
  "typescript": "^5.9.3"
}
```

`apps/web/package.json` keeps its direct `react: "19.2.3"` dependency. Plan 13's CSS ownership test—not this package plan—proves every emitted primitive class is styled in `styles.css` and that the app consumes the stylesheet once. Plan 14 verifies only the honest package disposition and successful consuming-app build; it does not edit the UI manifest or component/CSS source.

- [ ] **Step 5: Run package contracts to verify GREEN**

First gate on Plan 12's early additive root-manifest commit, from the repository root:

```bash
node --experimental-strip-types --input-type=module --eval 'await import("@viva/core/runtime-validation")'
```

Expected: exit 0. If it fails, the Plan 12 root `@viva/core` devDependency has not merged; stop and wait for that handoff instead of treating the commands below as unfixable failures. Then run:

```bash
node --test scripts/package-build-contract.test.mjs
bun run --cwd packages/ui-web typecheck
bun run --cwd apps/web build
! rg -F "Try again using the phrase 'shuttle system'." apps/web/.next
```

Expected: all five package-build tests PASS, including native Node import of the exact runtime-validation value surface and exact mounted-DOM pins; UI typecheck PASS; the web build uses the app as the React runtime owner rather than a UI-package runtime dependency; and the actual Next artifact contains no fake-evaluator-only feedback string.

- [ ] **Step 6: Commit only the Plan 14 test**

```bash
git add scripts/package-build-contract.test.mjs
git commit -m "test(build): enforce workspace package contracts"
```

### Task 4: Make Turbo output restoration and environment hashing truthful (`PACKAGE-04`)

**Files:**

- Modify: `turbo.json:55-57`
- Create: `scripts/prove-turbo-cache-restoration.mjs`
- Handoff modify (Plan 12): `package.json:26-33`
- Modify: `scripts/package-build-contract.test.mjs`
- Test: `scripts/prove-turbo-cache-restoration.mjs`

- [ ] **Step 1: Extend the contract test with failing Turbo assertions**

Append to `scripts/package-build-contract.test.mjs`:

```js
test("Turbo restores web build artifacts and hashes public build inputs", async () => {
  const rootPackage = await readJson("package.json");
  const turbo = await readJson("turbo.json");
  assert.equal(
    rootPackage.scripts?.["build:cache:prove"],
    "node scripts/prove-turbo-cache-restoration.mjs",
  );
  assert.equal(turbo.tasks.build.outputs.includes(".next/**"), true);
  assert.equal(turbo.tasks.build.outputs.includes("!.next/cache/**"), true);
  const requiredBuildEnv = [
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_API_URL",
    "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
  ];
  assert.equal(requiredBuildEnv.every((name) => turbo.tasks.build.env.includes(name)), true);
});
```

Run:

```bash
node --test --test-name-pattern='Turbo restores' scripts/package-build-contract.test.mjs
```

Expected: FAIL because `tasks.build.outputs` and `tasks.build.env` are absent.

- [ ] **Step 2: Declare the normal web build outputs and environment inputs**

Replace `turbo.json`'s `build` task with:

```json
"build": {
  "dependsOn": ["^build"],
  "env": [
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_API_URL",
    "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID"
  ],
  "outputs": [".next/**", "!.next/cache/**"]
}
```

Do not add server secrets to `globalEnv`. The normal server build must not prerender secret-derived tokens into a cache artifact; Plan 13's serverful page disposition must keep authenticated snapshot work request-time-only.

The four `NEXT_PUBLIC_VIVA_VOICE_*` entries exist only while Plan 10's selected `D-07` branch retains those reads in `LiveSessionPage.tsx`; if the recorded `D-07` branch removes them, Plan 14 removes those entries from `requiredBuildEnv`, `baseBuildEnv`, and `turbo.json` `tasks.build.env` in the same integration wave as Plan 10's removal, keeping the hashed-input list equal to the set of public variables actually read.

- [ ] **Step 3: Create an isolated cache restoration proof**

Create `scripts/prove-turbo-cache-restoration.mjs` with exactly:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
        NEXT_PUBLIC_VIVA_STATIC_EXPORT: "0",
        TURBO_TELEMETRY_DISABLED: "1",
        VIVA_STATIC_EXPORT: "0",
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
        NEXT_PUBLIC_VIVA_STATIC_EXPORT: "0",
        VIVA_STATIC_EXPORT: "0",
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
  if (hadNextOutput) renameSync(nextOutput, backupNext);

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
  if (hadNextOutput) renameSync(backupNext, nextOutput);
  rmSync(cacheDir, { force: true, recursive: true });
  rmSync(backupRoot, { force: true, recursive: true });
}

console.log("Turbo cache restoration and env-hash proof passed");
```

The two static-flag pins (`NEXT_PUBLIC_VIVA_STATIC_EXPORT: "0"`, `VIVA_STATIC_EXPORT: "0"`) keep inherited developer configuration — for example an exported `VIVA_STATIC_EXPORT=1` — from silently turning the normal proof into a static build, because baseline `apps/web/next.config.ts` reads both flags. They are harmless under either `D-06` branch. Note for ledger reconciliation: the `PACKAGE-04` clause "differing `VIVA_STATIC_EXPORT` hashes" applies only under `D-06` Branch A; under Branch B the flag is deleted entirely and that clause is satisfied by complete deletion.

- [ ] **Step 4: Receive Plan 12's explicit proof command**

Plan 12 adds this root `package.json` script next to `build` and owns any lockfile consequence:

```json
"build:cache:prove": "node scripts/prove-turbo-cache-restoration.mjs"
```

Like the root `@viva/core` devDependency, this script arrives via Plan 12's early additive root-manifest commit (program Section 4's root `package.json` row permits it), merged to integration before Step 5's GREEN run — not with Plan 12's final `12B` release merge.

- [ ] **Step 5: Run the config test and real cache proof to verify GREEN**

First gate on Plan 12's early additive root-manifest commit (which carries the `build:cache:prove` script), from the repository root:

```bash
node --experimental-strip-types --input-type=module --eval 'await import("@viva/core/runtime-validation")'
```

Expected: exit 0; otherwise stop and wait for the Plan 12 handoff. Then run:

```bash
node --test --test-name-pattern='Turbo restores' scripts/package-build-contract.test.mjs
node scripts/prove-turbo-cache-restoration.mjs
```

Expected:

- the config test PASS;
- the first isolated-cache build is a miss;
- deleting `apps/web/.next` removes the built artifact;
- the second build reports `@viva/web:build: cache hit` and restores the identical digest;
- changing `NEXT_PUBLIC_VIVA_API_URL` changes `@viva/web#build`'s dry-run hash;
- any pre-existing `.next` directory is restored in `finally`.

- [ ] **Step 6: Commit the cache contract**

```bash
git add turbo.json scripts/package-build-contract.test.mjs scripts/prove-turbo-cache-restoration.mjs
git commit -m "fix(build): make Turbo cache artifacts restorable"
```

### Task 5: Correct Apache license metadata (`PACKAGE-06`)

**Files:**

- Modify: `agent/Cargo.toml:11-15`
- Modify: `scripts/package-build-contract.test.mjs`
- Test: `scripts/package-build-contract.test.mjs`

- [ ] **Step 1: Add the failing workspace license test**

Append to `scripts/package-build-contract.test.mjs`:

```js
test("every Rust workspace package reports Apache-2.0", () => {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "agent/Cargo.toml"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  const workspaceMembers = new Set(metadata.workspace_members);
  const workspacePackages = metadata.packages.filter((pkg) => workspaceMembers.has(pkg.id));
  assert.equal(workspacePackages.length, 5);
  assert.deepEqual([...new Set(workspacePackages.map((pkg) => pkg.license))], ["Apache-2.0"]);
  assert.equal(
    workspacePackages.every((pkg) => Array.isArray(pkg.publish) && pkg.publish.length === 0),
    true,
  );
});
```

Run:

```bash
node --test --test-name-pattern='Apache-2.0' scripts/package-build-contract.test.mjs
```

Expected: FAIL because all five crates inherit `UNLICENSED`.

- [ ] **Step 2: Fix the single workspace authority**

Change only this line in `agent/Cargo.toml`:

```toml
license = "Apache-2.0"
```

Keep `publish = false` unchanged.

- [ ] **Step 3: Verify Cargo metadata and package contract GREEN**

```bash
node --test --test-name-pattern='Apache-2.0' scripts/package-build-contract.test.mjs
```

The Node test is authoritative: it must find exactly five workspace members, one unique license value `Apache-2.0`, and Cargo's `publish = false` representation (`publish: []`) for every member.

- [ ] **Step 4: Commit the metadata correction**

```bash
git add agent/Cargo.toml scripts/package-build-contract.test.mjs
git commit -m "fix(metadata): publish Apache workspace license"
```

### Task 6: Resolve `D-06 STATIC_EXPORT` with exactly one complete branch (`PACKAGE-05`)

**Files shared by either branch:**

- Modify: `apps/web/next.config.ts`
- Modify: `turbo.json`
- Modify: `scripts/package-build-contract.test.mjs`

**Branch-A-only Plan 14 files:**

- Create: `scripts/prove-static-turbo-cache-restoration.mjs`
- Create: `scripts/static-export-browser-gate.mjs`

**Branch-owner handoffs:**

- Plan 10: `apps/web/lib/viva-agent-client.ts`, `apps/web/lib/viva-agent-client.test.ts`
- Plan 11: `apps/web/proxy.ts`, `apps/web/lib/viva-security-headers.test.ts`
- Plan 13: `apps/web/lib/viva-library.ts`, `apps/web/lib/viva-library.test.ts`, `apps/web/app/page.tsx`, static landing tests
- Plan 12: root `package.json`, `bun.lock`, and any proof/static root scripts

- [ ] **Step 1: Add a branch-completeness test before selecting a branch**

Append to `scripts/package-build-contract.test.mjs`:

```js
test("D-06 STATIC_EXPORT is either fully gated or fully deleted", async () => {
  const rootPackage = await readJson("package.json");
  const turbo = await readJson("turbo.json");
  const sourcePaths = [
    "apps/web/next.config.ts",
    "apps/web/lib/viva-agent-client.ts",
    "apps/web/lib/viva-agent-client.test.ts",
    "apps/web/lib/viva-library.ts",
    "apps/web/lib/viva-library.test.ts",
    "apps/web/app/page.tsx",
    "apps/web/components/landing/LandingEntry.test.tsx",
  ];
  const source = (
    await Promise.all(sourcePaths.map((path) => readFile(join(root, path), "utf8")))
  ).join("\n");
  const hasStaticFlag = /(?:NEXT_PUBLIC_)?VIVA_STATIC_EXPORT/.test(source);
  const baseBuildEnv = [
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_API_URL",
    "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
  ];

  if (hasStaticFlag) {
    assert.equal(
      rootPackage.scripts?.["build:static"],
      "VIVA_STATIC_EXPORT=1 NEXT_PUBLIC_VIVA_STATIC_EXPORT=1 turbo run build --filter=@viva/web",
    );
    assert.equal(
      rootPackage.scripts?.["e2e:static"],
      "node scripts/static-export-browser-gate.mjs",
    );
    assert.equal(turbo.tasks["build:static"], undefined);
    assert.deepEqual(turbo.tasks.build.env, [
      ...baseBuildEnv,
      "NEXT_PUBLIC_VIVA_STATIC_EXPORT",
      "VIVA_STATIC_EXPORT",
    ]);
    assert.deepEqual(turbo.tasks.build.outputs, [
      ".next/**",
      "!.next/cache/**",
      "out/**",
    ]);
  } else {
    assert.equal(rootPackage.scripts?.["build:static"], undefined);
    assert.equal(rootPackage.scripts?.["e2e:static"], undefined);
    assert.equal(turbo.tasks["build:static"], undefined);
    assert.deepEqual(turbo.tasks.build.env, baseBuildEnv);
    assert.deepEqual(turbo.tasks.build.outputs, [".next/**", "!.next/cache/**"]);
    assert.doesNotMatch(JSON.stringify(turbo), /(?:NEXT_PUBLIC_)?VIVA_STATIC_EXPORT/);
  }
});
```

The four `NEXT_PUBLIC_VIVA_VOICE_*` entries in `baseBuildEnv` exist only while Plan 10's selected `D-07` branch retains those reads in `LiveSessionPage.tsx`; if the recorded `D-07` branch removes them, Plan 14 removes those entries from `requiredBuildEnv`, `baseBuildEnv`, and `turbo.json` `tasks.build.env` in the same integration wave as Plan 10's removal.

Run:

```bash
node --test --test-name-pattern='D-06 STATIC_EXPORT' scripts/package-build-contract.test.mjs
```

Expected on the reviewed tree: FAIL because static flags exist while the normal build omits static outputs/hash inputs and Plan 12 has not wired a served browser gate.

- [ ] **Step 2: Stop for Connor's recorded `D-06 STATIC_EXPORT` choice**

The coordinator must record either `D-06 STATIC_EXPORT: delete`, or a `retain` choice that spells out both the actual static deployment consumer and the separate server BFF by name. A worker must not infer the choice from the absence of a consumer, the current flags, or the review recommendation. Resume with only the matching `A` or `B` steps below.

- [ ] **Step 2A: Branch A — retain only after Connor's recorded choice names both consumers**

Skip this branch unless the coordinator's record of Connor's decision contains the actual static consumer name and names a separate server BFF for Plan 11's API routes, proxy, and nonce CSP. The current mixed Next application cannot simultaneously be an `output: "export"` artifact and the server BFF. When both consumers are named, make `apps/web/next.config.ts` retain the existing static switch and make the output branches explicit:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const staticExport =
  process.env.VIVA_STATIC_EXPORT === "1" || process.env.NEXT_PUBLIC_VIVA_STATIC_EXPORT === "1";

const sessionReferrerHeaders: Pick<NextConfig, "headers"> = staticExport
  ? {}
  : {
      async headers() {
        return [
          {
            source: "/session",
            headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
          },
        ];
      },
    };

const nextConfig: NextConfig = {
  assetPrefix: staticExport ? "." : undefined,
  env: {
    NEXT_PUBLIC_VIVA_STATIC_EXPORT: staticExport ? "1" : "0",
  },
  ...sessionReferrerHeaders,
  output: staticExport ? "export" : undefined,
  transpilePackages: ["@viva/core", "@viva/tokens", "@viva/ui-web"],
  turbopack: { root: workspaceRoot },
};

export default nextConfig;
```

Plan 12 adds these root `package.json` scripts and owns any lockfile consequence:

```json
"build:static": "VIVA_STATIC_EXPORT=1 NEXT_PUBLIC_VIVA_STATIC_EXPORT=1 turbo run build --filter=@viva/web",
"e2e:static": "node scripts/static-export-browser-gate.mjs"
```

Because `apps/web/next.config.ts` also reads the flags during the ordinary `build` task, extend Task 4's normal task so both artifact shapes and both flag values participate in its cache key:

```json
"build": {
  "dependsOn": ["^build"],
  "env": [
    "NEXT_PUBLIC_VIVA_AGENT_HTTP_URL",
    "NEXT_PUBLIC_VIVA_AGENT_WS_URL",
    "NEXT_PUBLIC_VIVA_API_URL",
    "NEXT_PUBLIC_VIVA_VOICE_SESSION_TOKEN",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_SESSION_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_STUDY_SET_ID",
    "NEXT_PUBLIC_VIVA_VOICE_TRUSTED_USER_ID",
    "NEXT_PUBLIC_VIVA_STATIC_EXPORT",
    "VIVA_STATIC_EXPORT"
  ],
  "outputs": [".next/**", "!.next/cache/**", "out/**"]
}
```

In `scripts/prove-turbo-cache-restoration.mjs`, confirm `runBuild`'s `env` object already matches this exact object (Task 4 Step 3 pins the static flags in the base script) so inherited developer configuration cannot change the normal proof into a static build:

```js
env: {
  ...process.env,
  NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: "https://agent-a.invalid",
  NEXT_PUBLIC_VIVA_AGENT_WS_URL: "wss://agent-a.invalid/ws",
  NEXT_PUBLIC_VIVA_API_URL: "https://api-a.invalid",
  NEXT_PUBLIC_VIVA_STATIC_EXPORT: "0",
  TURBO_TELEMETRY_DISABLED: "1",
  VIVA_STATIC_EXPORT: "0",
  ...extraEnv,
},
```

Likewise confirm `dryRunHash`'s `env` object matches:

```js
env: {
  ...process.env,
  NEXT_PUBLIC_VIVA_API_URL: publicApiUrl,
  NEXT_PUBLIC_VIVA_STATIC_EXPORT: "0",
  VIVA_STATIC_EXPORT: "0",
},
```

Plan 10 must keep direct agent URL selection for static browsers and test that the same-origin API proxy is not selected. Plan 13 must keep direct session/control capability projection only for the named static consumer and add mounted browser coverage; static capability tokens must remain in the URL fragment, never query or rendered HTML. Plan 11's `proxy.ts`, nonce CSP, `/api/viva-session/projection`, and other API routes must build and run on the separately named server BFF; they cannot be claimed from the static artifact.

- [ ] **Step 3A: Branch A — add a real served static browser gate**

Create `scripts/static-export-browser-gate.mjs` with exactly:

```js
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "apps/web/out");
assert.ok(existsSync(join(outputRoot, "index.html")), "run bun run build:static first");

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function staticPath(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0]);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const candidates = [
    join(outputRoot, relativePath),
    join(outputRoot, `${relativePath}.html`),
    join(outputRoot, relativePath, "index.html"),
  ];
  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    if (!normalized.startsWith(`${outputRoot}${sep}`) && normalized !== outputRoot) continue;
    if (existsSync(normalized) && statSync(normalized).isFile()) return normalized;
  }
  return null;
}

const server = createServer((request, response) => {
  const path = staticPath(request.url ?? "/");
  if (!path) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": mime[extname(path)] ?? "application/octet-stream",
  });
  response.end(readFileSync(path));
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedResponses = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1, name: /All you must know/i }).waitFor();
  await page.goto(`${baseUrl}/session`, { waitUntil: "networkidle" });
  await page.locator(".live-session").waitFor();

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

console.log("Static export build and browser gate passed");
```

Run:

```bash
bun run build:static
bun run e2e:static
bun test apps/web/lib/viva-security-headers.test.ts
VIVA_STATIC_EXPORT=0 NEXT_PUBLIC_VIVA_STATIC_EXPORT=0 bun --cwd apps/web run build
bun run e2e:browser
```

Expected: `apps/web/out/index.html` and the `/session` artifact exist; Playwright serves and loads both routes with zero console/page errors. The server-BFF gate separately proves nonce CSP and `/api/viva-session/projection`. If Next rejects the app's dynamic route handlers under `output: "export"`, or if the separately named server BFF is absent, Branch A is blocked and must not be called retained; wait for Connor's revised choice or the separately owned consumer/BFF delivery.

- [ ] **Step 4A: Branch A — prove static cache hashing and restoration**

Create `scripts/prove-static-turbo-cache-restoration.mjs` with exactly:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
const output = join(root, "apps/web/out");
const nextOutput = join(root, "apps/web/.next");
const cacheDir = mkdtempSync(join(tmpdir(), "viva-static-turbo-cache-"));
const backupRoot = mkdtempSync(join(tmpdir(), "viva-static-output-backup-"));
const backupOutput = join(backupRoot, "out");
const backupNext = join(backupRoot, ".next");
const hadOutput = existsSync(output);
const hadNextOutput = existsSync(nextOutput);

function runBuild() {
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
        NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: "https://agent-static.invalid",
        NEXT_PUBLIC_VIVA_AGENT_WS_URL: "wss://agent-static.invalid/ws",
        NEXT_PUBLIC_VIVA_API_URL: "https://api-static.invalid",
        NEXT_PUBLIC_VIVA_STATIC_EXPORT: "1",
        TURBO_TELEMETRY_DISABLED: "1",
        VIVA_STATIC_EXPORT: "1",
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
      if (metadata.isDirectory()) visit(absolute);
      else {
        hash.update(relative(directory, absolute));
        hash.update(readFileSync(absolute));
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}

function dryRunHash(staticFlag) {
  const result = spawnSync(
    "bunx",
    ["turbo", "run", "build", "--filter=@viva/web", "--dry-run=json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_VIVA_STATIC_EXPORT: "0",
        VIVA_STATIC_EXPORT: staticFlag,
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
  if (hadOutput) renameSync(output, backupOutput);
  if (hadNextOutput) renameSync(nextOutput, backupNext);

  const coldLog = runBuild();
  assert.ok(existsSync(output), "cold static build must create apps/web/out");
  assert.doesNotMatch(coldLog, /@viva\/web:build: cache hit/);
  const coldDigest = digestTree(output);

  rmSync(output, { force: true, recursive: true });
  const restoredLog = runBuild();
  assert.match(restoredLog, /@viva\/web:build: cache hit/);
  assert.ok(existsSync(output), "cache hit must restore apps/web/out");
  assert.equal(digestTree(output), coldDigest);

  assert.notEqual(
    dryRunHash("0"),
    dryRunHash("1"),
    "VIVA_STATIC_EXPORT must change the static build hash",
  );
} finally {
  rmSync(output, { force: true, recursive: true });
  rmSync(nextOutput, { force: true, recursive: true });
  if (hadOutput) renameSync(backupOutput, output);
  if (hadNextOutput) renameSync(backupNext, nextOutput);
  rmSync(cacheDir, { force: true, recursive: true });
  rmSync(backupRoot, { force: true, recursive: true });
}

console.log("Static Turbo cache restoration and env-hash proof passed");
```

Run:

```bash
node scripts/prove-static-turbo-cache-restoration.mjs
```

Expected: cold static build, deletion of `out`, cache-hit restoration with identical digest, and distinct dry-run hashes for static flag `0` versus `1`.

- [ ] **Step 2B: Branch B — delete the Plan 14 static build configuration**

Use this complete `apps/web/next.config.ts`:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/session",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
  transpilePackages: ["@viva/core", "@viva/tokens", "@viva/ui-web"],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
```

Keep Task 4's normal `build` task with outputs `[".next/**", "!.next/cache/**"]`. Do not add `out/**`, either static flag, a `build:static` task, or static scripts.

Plan 12 removes the root `package.json` keys `scripts.build:static` and `scripts.e2e:static` if they exist, preserves `scripts.build:cache:prove`, and owns any manifest/lockfile commit.

Plan 10 must delete from `viva-agent-client.ts` and its tests:

- `bundledVivaStaticExport`
- `bundledNextPublicVivaStaticExport`
- `vivaStaticExportEnabled`
- the `browserVivaLibraryProxyBaseUrl` static bypass
- every save/restore/set/assertion for either static flag

Plan 13 must delete:

- `staticExport?: boolean` from `browserInitialLibrarySnapshot`
- static-only token-preservation behavior and tests in `viva-library.ts`/`.test.ts`
- `vivaStaticExportEnabled` import/call from `app/page.tsx`
- the static-export-only direct signed-token target and compatibility tests in landing coverage

The serverful behavior remains: browser snapshots strip control/session tokens, same-origin proxy routing remains authoritative, and `/session` keeps `Referrer-Policy: no-referrer`.

- [ ] **Step 3B: Branch B — prove repository-wide deletion**

Run:

```bash
rg -n 'VIVA_STATIC_EXPORT|NEXT_PUBLIC_VIVA_STATIC_EXPORT|vivaStaticExportEnabled|staticExport' apps packages scripts package.json turbo.json -g '!package-build-contract.test.mjs' -g '!prove-turbo-cache-restoration.mjs'
```

Expected: no matches. A match in a test is still a failed deletion. The two excluded files are the only permitted mentions: the enforcement test asserts the deletion, and the cache-proof script's inert `"0"` pins (Task 4 Step 3) guard against stale developer environment without reading any deleted code path.

Then run:

```bash
node --test --test-name-pattern='D-06 STATIC_EXPORT' scripts/package-build-contract.test.mjs
bun test apps/web/lib/viva-security-headers.test.ts
bun --cwd apps/web run build
bun run e2e:browser
```

Expected: branch-completeness and CSP tests PASS; the normal server build includes API routes and `proxy.ts`; browser evidence proves distinct per-response CSP nonces, fixed defense headers, and a live `/api/viva-session/projection` server route.

- [ ] **Step 5: Commit only the selected branch after owner handoffs are present**

Branch A:

```bash
git add apps/web/next.config.ts turbo.json scripts/package-build-contract.test.mjs scripts/prove-turbo-cache-restoration.mjs scripts/prove-static-turbo-cache-restoration.mjs scripts/static-export-browser-gate.mjs
git commit -m "feat(build): gate named static export consumer"
```

Branch B:

```bash
git add apps/web/next.config.ts turbo.json scripts/package-build-contract.test.mjs
git commit -m "refactor(build): remove unused static export mode"
```

Do not stage Plan 10 or Plan 13 owner files in the Plan 14 commit.

### Task 7: Freeze the combined package/build contract and hand claims to Plan 15 (`PACKAGE-01`–`PACKAGE-09`)

**Files:**

- Test: `packages/core/src/package-exports.test.ts`
- Test: `scripts/package-build-contract.test.mjs`
- Verify: all Plan 14 files and owner handoffs
- Handoff only: Plan 15 documentation files

- [ ] **Step 1: Run focused package and metadata tests without Turbo cache**

First gate on Plan 12's early additive root-manifest commit, from the repository root:

```bash
node --experimental-strip-types --input-type=module --eval 'await import("@viva/core/runtime-validation")'
```

Expected: exit 0; otherwise the root `@viva/core` devDependency and `build:cache:prove` script have not merged — stop and wait for that handoff. Then run:

```bash
bun test packages/core/src/package-exports.test.ts packages/core/src/index.test.ts packages/core/src/agent-contract.test.ts
node --test scripts/package-build-contract.test.mjs
bunx turbo run typecheck lint test --force
```

Expected: every command PASS. The forced Turbo run must report no cache hits.

- [ ] **Step 2: Run the real build restoration proof**

```bash
bun run build:cache:prove
```

Expected: cold normal build, deleted output, cache-hit restoration, identical digest, and public env hash divergence all PASS.

If and only if Branch A was selected, also run:

```bash
bun run build:static
bun run e2e:static
node scripts/prove-static-turbo-cache-restoration.mjs
```

Expected: static build, served Playwright routes, static output restoration, and static flag hash divergence all PASS.

- [ ] **Step 3: Run full local validation on the frozen combined tree**

```bash
bun run validate
git diff --check
git status --short
```

Expected: validation PASS; `git diff --check` emits nothing; status contains only intended plan/implementation changes and any explicitly preserved unrelated user work.

- [ ] **Step 4: Verify every review obligation by executable query**

```bash
rg -n '"@viva/core/\*"|"\./\*"' tsconfig.base.json packages/core/package.json
rg -nU --multiline-dotall 'import[^;]*\b(sampleQuestion|seedStudySets|sourceConflictExample|evaluateAnswer|buildSessionRecap)\b[^;]*from "@viva/core";' apps packages
! rg -F "Try again using the phrase 'shuttle system'." apps/web/.next
cargo metadata --format-version 1 --no-deps --manifest-path agent/Cargo.toml >/dev/null
```

Expected: all three `rg` checks return no matches; Cargo metadata parses successfully and the Node contract test has already asserted its five licenses and `publish` flags.

- [ ] **Step 5: Send Plan 15 the exact documentation truth**

The handoff must contain:

- `@viva/core` root is production-only;
- deterministic seeds are at `@viva/core/fixtures`;
- the fake evaluator is test-only at `@viva/core/testing/fake-evaluator` and is absent from the production bundle proof;
- `@viva/core/runtime-validation` is native Node 24 pure ESM, exposes exactly the owner-supplied runtime keys, and aggregates the strict Plan 04/05 validators without wrappers;
- deep imports are unsupported because exports and paths are exact and wildcard-free;
- `@viva/ui-web` is a small private package, not a general reusable design system, and React is app-owned via a peer contract;
- Turbo restores the declared `.next` artifact byte-for-byte (excluding `.next/cache`) and hashes the enumerated public build inputs;
- all Rust workspace crates report `Apache-2.0` and remain unpublished;
- for Branch A, name the actual static deployment consumer and separate server BFF, and cite both static and server build/browser evidence;
- for Branch B, state that static export was deleted and remove every public claim that it remains supported.

Plan 15 must not claim hosted, CI, or release correctness from these local proofs.

The executable status/evidence vocabulary test for `INTEGRATION-007` is Plan 15's `scripts/public-contract.test.mjs`; Plan 14 supplies only this prose handoff, not a failing docs-contract test. The coordinator must amend the three ledger rows that credit "Plan 14 `PACKAGE-08`" with supplying that test (architecture-consistency Minor M3, Shared packages R4, Architecture component R5) to name Plan 15's test instead.

- [ ] **Step 6: Commit the final Plan 14 evidence wiring**

```bash
git add packages/core/package.json packages/core/src/index.ts packages/core/src/study-set.ts packages/core/src/fixtures.ts packages/core/src/testing/fake-evaluator.ts packages/core/src/runtime-validation.ts packages/core/src/package-exports.test.ts packages/core/src/index.test.ts tsconfig.base.json turbo.json apps/web/next.config.ts agent/Cargo.toml scripts/package-build-contract.test.mjs scripts/prove-turbo-cache-restoration.mjs
test -z "$(git diff --cached --name-only -- packages/core/src/agent-contract.test.ts)"
git diff --cached --check
git commit -m "test(build): close package and cache contracts"
```

For Branch A, add `scripts/prove-static-turbo-cache-restoration.mjs` and `scripts/static-export-browser-gate.mjs` to that explicit staging list. Plan 12 stages root manifest changes separately. Never use `git add .` in this mixed worktree.

## Completion criteria

Plan 14 is complete only when all of the following are true on one frozen combined SHA:

- `PACKAGE-01`: root runtime exports contain none of the five fixture/fake values.
- `PACKAGE-02`: the negative-control bundle contains the fake-evaluator string and the production bundle does not.
- `PACKAGE-03`: package exports and TS aliases match exactly, with no wildcard and no root fixture imports.
- `PACKAGE-04`: the declared normal web artifact is restored byte-for-byte after deletion (excluding `.next/cache`), and changing a declared public env input changes the Turbo hash.
- `PACKAGE-05`: the coordinator has recorded Connor's exact choice and exactly one branch passes. Retention has a named static consumer, a separate named server BFF, and both evidence sets; deletion has zero implementation or behavior-test matches (the package-build enforcement test and the cache-proof script's inert flag pins remain).
- `PACKAGE-06`: Cargo metadata reports five Apache-2.0 unpublished workspace crates.
- `PACKAGE-07`: Plan 13's private UI manifest exposes only the root component surface plus its owned stylesheet, depends on tokens, uses a React peer plus test-time dev dependency, and the app still builds; Plan 12 pins both mounted-DOM packages to `20.11.6`.
- `PACKAGE-08`: Plan 15 has the exact branch/evidence handoff and makes no stronger claim.
- `PACKAGE-09`: root Node 24 resolves the workspace subpath, imports its exact value surface without a custom loader or bundler, and receives the identical Plan 04/05 function objects rather than wrappers or duplicate validators.
- Forced local validation passes. Hosted exact-SHA CI, protected-branch state, and release evidence remain separate higher-level gates.
