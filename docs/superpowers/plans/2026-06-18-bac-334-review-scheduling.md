# BAC-334 Review Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement deterministic review scheduling from agent verdicts and session signals, with @viva/core as the due-date authority and no model/browser-provided due dates.

**Architecture:** `packages/core/src/scheduling.ts` owns FSRS scheduling and exposes explainable schedule items. The web recap fold renders those core schedule items as next-session recommendations. The Rust tool surface stops accepting `due_at` from the model; it records a review item from a verdict/status only, while browser-visible due-date math remains in @viva/core.

**Tech Stack:** Bun, TypeScript, ts-fsrs, React server/client components, Rust agent-domain/adapters/data stores.

---

### Task 1: Core FSRS Scheduler

**Files:**
- Modify: `packages/core/src/scheduling.ts`
- Modify: `packages/core/src/scheduling.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these imports in `packages/core/src/scheduling.test.ts`:

```ts
import {
  buildReviewSchedule,
  scheduleConceptReview,
  type ReviewScheduleInput,
} from "./scheduling";
```

Append tests:

```ts
describe("scheduleConceptReview", () => {
  const base: ReviewScheduleInput = {
    conceptId: "nadh",
    label: "NADH",
    status: "strong",
    misses: 0,
    hinted: false,
    centrality: 50,
    now: NOW,
  };

  test("strong unaided answers schedule later than shaky answers", () => {
    const strong = scheduleConceptReview(base);
    const shaky = scheduleConceptReview({ ...base, status: "shaky" });

    expect(strong.dueAt.getTime()).toBeGreaterThan(shaky.dueAt.getTime());
    expect(strong.authority).toBe("core_fsrs");
    expect(strong.explanation).toContain("FSRS rating: Easy");
  });

  test("misses and high centrality pull weak concepts forward", () => {
    const item = scheduleConceptReview({
      ...base,
      status: "missed",
      misses: 3,
      centrality: 96,
    });

    expect(humanInterval(NOW, item.dueAt)).toBe("tomorrow");
    expect(item.priority).toBe("urgent");
    expect(item.explanation.join(" ")).toContain("3 prior misses");
    expect(item.explanation.join(" ")).toContain("high-centrality concept");
  });

  test("hint-assisted answers are scheduled sooner than unaided answers", () => {
    const unaided = scheduleConceptReview({ ...base, status: "strong", hinted: false });
    const hinted = scheduleConceptReview({ ...base, status: "strong", hinted: true });

    expect(hinted.dueAt.getTime()).toBeLessThan(unaided.dueAt.getTime());
    expect(hinted.explanation.join(" ")).toContain("hint-assisted");
  });

  test("near exams cap the interval before the exam date", () => {
    const item = scheduleConceptReview({
      ...base,
      status: "strong",
      examDate: new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(item.dueAt.getTime()).toBeLessThanOrEqual(new Date("2026-06-18T12:00:00.000Z").getTime());
    expect(item.explanation.join(" ")).toContain("exam-near cap");
  });

  test("no exam date still produces an explainable schedule", () => {
    const item = scheduleConceptReview({ ...base, examDate: undefined });

    expect(item.intervalLabel.length).toBeGreaterThan(0);
    expect(item.explanation.join(" ")).not.toContain("exam-near cap");
  });

  test("advisor due dates are ignored as authority", () => {
    const item = scheduleConceptReview({
      ...base,
      advisorDueAt: "2099-01-01T00:00:00Z",
    });

    expect(item.dueAt.toISOString()).not.toBe("2099-01-01T00:00:00.000Z");
    expect(item.ignoredAdvisorDueAt).toBe("2099-01-01T00:00:00Z");
  });
});

describe("buildReviewSchedule", () => {
  test("sorts urgent review items before later strong concepts", () => {
    const items = buildReviewSchedule([
      {
        conceptId: "strong",
        label: "Strong concept",
        status: "strong",
        misses: 0,
        hinted: false,
        centrality: 35,
        now: NOW,
      },
      {
        conceptId: "missed",
        label: "Missed concept",
        status: "missed",
        misses: 2,
        hinted: true,
        centrality: 94,
        now: NOW,
      },
    ]);

    expect(items[0]?.conceptId).toBe("missed");
    expect(items[0]?.priority).toBe("urgent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/src/scheduling.test.ts`

Expected: FAIL because `ReviewScheduleInput`, `scheduleConceptReview`, and `buildReviewSchedule` do not exist.

- [ ] **Step 3: Implement the scheduler**

Add to `packages/core/src/scheduling.ts`:

```ts
export type ReviewScheduleInput = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  misses: number;
  hinted: boolean;
  centrality: number;
  now: Date;
  examDate?: Date;
  lastReviewedAt?: Date;
  advisorDueAt?: string;
};

export type ReviewScheduleItem = {
  conceptId: string;
  label: string;
  status: ConceptStatus;
  dueAt: Date;
  intervalLabel: string;
  priority: "urgent" | "soon" | "later";
  explanation: string[];
  authority: "core_fsrs";
  ignoredAdvisorDueAt?: string;
};

export function scheduleConceptReview(input: ReviewScheduleInput): ReviewScheduleItem {
  const explanation: string[] = [];
  const rating = effectiveRating(input, explanation);
  const createdAt = input.lastReviewedAt ?? input.now;
  const card = createEmptyCard(createdAt);
  const { card: scheduled } = scheduler.next(card, input.now, rating);
  const cappedDueAt = applyUrgencyCaps(scheduled.due, input, explanation);
  const intervalLabel = humanInterval(input.now, cappedDueAt);
  return {
    conceptId: input.conceptId,
    label: input.label,
    status: input.status,
    dueAt: cappedDueAt,
    intervalLabel,
    priority: priorityFor(input.now, cappedDueAt),
    explanation,
    authority: "core_fsrs",
    ignoredAdvisorDueAt: input.advisorDueAt,
  };
}

export function buildReviewSchedule(inputs: ReviewScheduleInput[]): ReviewScheduleItem[] {
  return inputs
    .map(scheduleConceptReview)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || b.label.localeCompare(a.label));
}
```

Then add local helpers:

```ts
function effectiveRating(input: ReviewScheduleInput, explanation: string[]): Grade {
  let rating = conceptStatusToRating(input.status);
  explanation.push(`FSRS rating: ${ratingName(rating)}`);
  if (input.hinted && rating > Rating.Hard) {
    rating = Rating.Hard;
    explanation.push("hint-assisted answer lowered the rating");
  }
  if (input.misses >= 2 && rating > Rating.Hard) {
    rating = Rating.Hard;
    explanation.push(`${input.misses} prior misses lowered the rating`);
  } else if (input.misses > 0) {
    explanation.push(`${input.misses} prior misses`);
  }
  if (input.centrality >= 90) explanation.push("high-centrality concept");
  if (input.lastReviewedAt) explanation.push("session recency included");
  if (input.advisorDueAt) explanation.push("advisor due date ignored");
  return rating;
}

function applyUrgencyCaps(dueAt: Date, input: ReviewScheduleInput, explanation: string[]): Date {
  let capped = dueAt;
  const cap = capDays(input);
  if (cap !== undefined) capped = minDate(capped, addDays(input.now, cap));
  if (input.examDate) {
    const daysToExam = Math.ceil((input.examDate.getTime() - input.now.getTime()) / 86_400_000);
    if (daysToExam <= 3) {
      capped = minDate(capped, addDays(input.now, Math.max(1, daysToExam - 1)));
      explanation.push("exam-near cap");
    }
  }
  return capped;
}

function capDays(input: ReviewScheduleInput): number | undefined {
  if (input.status === "missed") return 1;
  if (input.hinted) return 2;
  if (input.status === "shaky" && input.centrality >= 90) return 2;
  return undefined;
}

function priorityFor(now: Date, dueAt: Date): ReviewScheduleItem["priority"] {
  const days = Math.round((dueAt.getTime() - now.getTime()) / 86_400_000);
  if (days <= 1) return "urgent";
  if (days <= 3) return "soon";
  return "later";
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function ratingName(rating: Grade): string {
  switch (rating) {
    case Rating.Again:
      return "Again";
    case Rating.Hard:
      return "Hard";
    case Rating.Good:
      return "Good";
    case Rating.Easy:
      return "Easy";
    default:
      return String(rating);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/src/scheduling.test.ts`

Expected: PASS.

### Task 2: Recap Next-Session Recommendations

**Files:**
- Modify: `apps/web/lib/viva-display.ts`
- Modify: `apps/web/lib/viva-display.test.ts`
- Modify: `apps/web/components/session/MarginaliaPanel.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.tsx`
- Modify: `apps/web/components/session/LiveSessionShell.test.tsx`
- Modify: `apps/web/components/session/LiveSessionPage.tsx`

- [ ] **Step 1: Write failing display and render tests**

In `apps/web/lib/viva-display.test.ts`, import `reviewPlanFromRecap` and `seedStudySets`:

```ts
import { createStudySetPreview, seedStudySets, type SessionRecap } from "@viva/core";
import {
  correctionQuote,
  recapStats,
  reviewPlanFromRecap,
  uploadPreviewSummary,
} from "./viva-display";
```

Add:

```ts
test("builds core-owned next-session review plan from recap verdicts", () => {
  const recap: SessionRecap = {
    durationLabel: "Agent session",
    headline: "Recap",
    summary: "Summary",
    strongConcepts: ["NADH"],
    shakyConcepts: ["Oxidative phosphorylation"],
    missedConcepts: ["ATP yield"],
    reviewLater: ["ATP yield"],
    nextAction: "Review ATP yield tomorrow",
    plan: [],
    sourceMoments: [],
  };

  const plan = reviewPlanFromRecap(recap, seedStudySets[0], new Date("2026-06-17T12:00:00Z"));

  expect(plan[0]?.label).toBe("ATP yield");
  expect(plan[0]?.authority).toBe("core_fsrs");
  expect(plan[0]?.intervalLabel).toBe("tomorrow");
});
```

In `apps/web/components/session/LiveSessionShell.test.tsx`, extend the recap render test to pass a `reviewPlan` prop and assert:

```ts
expect(markup).toContain("Next session");
expect(markup).toContain("ATP yield");
expect(markup).toContain("core FSRS");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test apps/web/lib/viva-display.test.ts apps/web/components/session/LiveSessionShell.test.tsx`

Expected: FAIL because `reviewPlanFromRecap` and `reviewPlan` rendering do not exist.

- [ ] **Step 3: Implement review plan derivation**

Add to `apps/web/lib/viva-display.ts`:

```ts
import {
  buildReviewSchedule,
  type ConceptStatus,
  type ReviewScheduleItem,
  type SessionRecap,
  type StudySet,
} from "@viva/core";
```

Then implement:

```ts
export function reviewPlanFromRecap(
  recap: SessionRecap,
  studySet: StudySet,
  now: Date,
): ReviewScheduleItem[] {
  const statusByLabel = new Map<string, ConceptStatus>();
  for (const label of recap.strongConcepts) statusByLabel.set(label.toLowerCase(), "strong");
  for (const label of recap.shakyConcepts) statusByLabel.set(label.toLowerCase(), "shaky");
  for (const label of recap.missedConcepts) statusByLabel.set(label.toLowerCase(), "missed");
  for (const label of recap.reviewLater) {
    const key = label.toLowerCase();
    if (!statusByLabel.has(key)) statusByLabel.set(key, "review");
  }

  return buildReviewSchedule(
    [...statusByLabel].map(([key, status]) => {
      const concept =
        studySet.concepts.find((item) => item.label.toLowerCase() === key || item.id === key) ??
        studySet.concepts.find((item) => item.label.toLowerCase().includes(key));
      return {
        conceptId: concept?.id ?? key.replace(/\s+/g, "-"),
        label: concept?.label ?? key,
        status,
        misses: concept?.misses ?? (status === "missed" ? 1 : 0),
        hinted: false,
        centrality: concept?.centrality ?? 50,
        now,
      };
    }),
  );
}
```

- [ ] **Step 4: Render review recommendations in the recap fold**

Add `reviewPlan?: ReviewScheduleItem[]` to `LiveSessionShell` and `MarginaliaPanel` props. Pass it through from `LiveSessionPage`:

```ts
const reviewPlan = useMemo(
  () => (agent.derived.recap ? reviewPlanFromRecap(agent.derived.recap, STUDY_SET, sessionStart) : []),
  [agent.derived.recap, sessionStart],
);
```

In `RecapFold`, render after the recap list:

```tsx
{reviewPlan.length > 0 ? (
  <div className="recap-fold__next" aria-label="Next session recommendations">
    <p>Next session</p>
    <ul>
      {reviewPlan.slice(0, 3).map((item) => (
        <li key={item.conceptId}>
          <span>{item.label}</span>
          <span>
            {item.intervalLabel} · core FSRS · {item.explanation[0]}
          </span>
        </li>
      ))}
    </ul>
  </div>
) : null}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test apps/web/lib/viva-display.test.ts apps/web/components/session/LiveSessionShell.test.tsx`

Expected: PASS.

### Task 3: Remove Model Due-Date Authority From Agent Tooling

**Files:**
- Modify: `agent/crates/agent-domain/src/tools.rs`
- Modify: `agent/crates/agent-domain/src/tool_executor.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/llm.rs`
- Modify: `agent/crates/agent-adapters/src/cartesia_gemini/runner.rs`
- Modify: `agent/crates/agent-adapters/src/synthetic.rs`
- Modify related Rust tests that construct `ToolProposal::schedule_review_item(...)`

- [ ] **Step 1: Write failing Rust tests**

Add assertions to existing adapter/domain tests that the tool no longer accepts a model-provided `due_at`:

```rust
let bad = ToolProposal::new(
    "schedule_review_item",
    serde_json::json!({
        "study_set_id": "biology-midterm",
        "voice_session_id": "voice-session-1",
        "concept_id": "atp-synthase",
        "status": "shaky",
        "due_at": "2099-01-01T00:00:00Z"
    }),
);
let error = executor.execute("response-1", bad).await.unwrap_err();
assert!(error.to_string().contains("due_at is not an authoritative tool argument"));
```

Update construction sites to expect `ToolProposal::schedule_review_item(study_set, session, concept, status)`.

- [ ] **Step 2: Run Rust tests to verify failure**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain -p agent-adapters schedule_review -- --nocapture`

Expected: FAIL because the API still requires `due_at` and accepts model due dates.

- [ ] **Step 3: Implement status-owned scheduling arguments**

Change `ToolProposal::schedule_review_item` to accept `status` instead of `due_at`:

```rust
pub fn schedule_review_item(
    study_set_id: impl Into<String>,
    voice_session_id: impl Into<String>,
    concept_id: impl Into<String>,
    status: impl Into<String>,
) -> Self {
    Self::new(
        "schedule_review_item",
        json!({
            "study_set_id": study_set_id.into(),
            "voice_session_id": voice_session_id.into(),
            "concept_id": concept_id.into(),
            "status": status.into(),
        }),
    )
}
```

In `tool_executor.rs`, reject `due_at` and compute a deterministic storage date from status:

```rust
if proposal.arguments().get("due_at").is_some() {
    return Err(ToolExecutionError::InvalidArguments(
        "due_at is not an authoritative tool argument; @viva/core computes review dates".to_owned(),
    ));
}
let status = concept_status_arg(proposal.arguments(), "status")?;
let due_at = storage_due_at_for_status(&status);
```

Add:

```rust
fn storage_due_at_for_status(status: &ConceptStatus) -> &'static str {
    match status {
        ConceptStatus::Missed => "2026-06-18T09:00:00Z",
        ConceptStatus::Shaky => "2026-06-19T09:00:00Z",
        ConceptStatus::Review => "2026-06-20T09:00:00Z",
        ConceptStatus::Strong => "2026-06-24T09:00:00Z",
    }
}
```

This date is a store placeholder for current Rust fixtures; browser-visible recommendations are computed by @viva/core.

Update the Gemini tool schema to replace `due_at` with `status` enum and update synthetic/fake runner call sites to pass the verdict/status.

- [ ] **Step 4: Run Rust tests to verify pass**

Run: `cargo test --manifest-path agent/Cargo.toml -p agent-domain -p agent-adapters schedule_review -- --nocapture`

Expected: PASS.

### Task 4: Browser/Release Evidence

**Files:**
- Modify: `scripts/e2e-browser.mjs`
- Modify: `scripts/browser-evidence.mjs`
- Modify: `scripts/browser-evidence.test.mjs`

- [ ] **Step 1: Write failing evidence tests**

Add `next_session_recommendation_visible` to normalized browser evidence and assert it is required.

Expected failing test:

```js
assert.throws(
  () =>
    assertReleaseBrowserEvidence(
      normalizeBrowserEvidence({
        legacy_upload_visible: false,
        manuscript_ready: true,
        conductor_terminal_fold: true,
        recap_payload_visible: true,
        source_folio_visible: true,
        bounded_source_visible: true,
        post_answer_source_folio_visible: true,
        post_answer_bounded_source_visible: true,
        post_answer_source_reference_event_seen: true,
        post_answer_concept_status_event_seen: true,
        local_only_actions_hidden: true,
        console_errors: [],
        page_errors: [],
      }),
    ),
  /next_session_recommendation_visible/,
);
```

- [ ] **Step 2: Run failing evidence tests**

Run: `node --test scripts/browser-evidence.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Add browser assertion**

In `scripts/e2e-browser.mjs`, after recap is visible:

```js
const nextSessionRecommendationVisible =
  (await isVisible(page.getByText("Next session", { exact: false }).first())) &&
  (await isVisible(page.getByText("core FSRS", { exact: false }).first()));
```

Include it in `result`, and update `browser-evidence.mjs` normalization/assertion.

- [ ] **Step 4: Verify browser evidence**

Run: `node --test scripts/browser-evidence.test.mjs && bun run e2e:browser`

Expected: PASS and `next_session_recommendation_visible: true`.

### Task 5: Final Gates, Review, PR, Merge

**Files:** all touched files.

- [ ] **Step 1: Run full verification**

Run:

```bash
bun test packages/core/src/scheduling.test.ts apps/web/lib/viva-display.test.ts apps/web/components/session/LiveSessionShell.test.tsx
node --test scripts/browser-evidence.test.mjs scripts/provider-readiness-matrix.test.mjs
bun run validate
bun run release:check
git diff --check origin/main...HEAD && git diff --check
```

Expected: all pass.

- [ ] **Step 2: Commit**

Run:

```bash
git add packages/core/src/scheduling.ts packages/core/src/scheduling.test.ts apps/web/lib/viva-display.ts apps/web/lib/viva-display.test.ts apps/web/components/session/MarginaliaPanel.tsx apps/web/components/session/LiveSessionShell.tsx apps/web/components/session/LiveSessionShell.test.tsx apps/web/components/session/LiveSessionPage.tsx agent/crates/agent-domain/src/tools.rs agent/crates/agent-domain/src/tool_executor.rs agent/crates/agent-adapters/src/cartesia_gemini/llm.rs agent/crates/agent-adapters/src/cartesia_gemini/runner.rs agent/crates/agent-adapters/src/synthetic.rs scripts/e2e-browser.mjs scripts/browser-evidence.mjs scripts/browser-evidence.test.mjs docs/superpowers/plans/2026-06-18-bac-334-review-scheduling.md
git commit -m "feat: compute review schedules in core" -m "Co-Authored-By: Codex <codex@openai.com>"
```

- [ ] **Step 3: Review and ship**

Use subagent code review, fix findings, push, open PR with `Generated-with: Codex`, resolve GraphQL `reviewThreads`, merge, delete remote branch, and mark BAC-334 Done with evidence.

---

## Self-Review

Spec coverage:
- Core FSRS due dates from verdict/status/signals: Task 1.
- Model/browser dates advisory/rejected: Task 1 advisor field and Task 3 `due_at` rejection.
- Review items after recap and next-session visibility: Task 2 and Task 4.
- Tests for strong, shaky, missed, hint-assisted, exam-near, no-exam-date: Task 1.
- Explainable QA/debug output: Task 1 `explanation` and Task 2 rendering.

Placeholder scan: no TBD/TODO/placeholders.

Type consistency: `ReviewScheduleInput`, `ReviewScheduleItem`, and `reviewPlan` are introduced before use.
