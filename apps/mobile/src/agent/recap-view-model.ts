import type { AgentTerminalSessionReason, ConceptStatus, SessionRecap, StudySet } from "@viva/core";
import { recapPlanFromSessionEvents, recapStats } from "@/agent/shared-web";

export type RecapColorToken = "ochre" | "plumVivid" | "sageDeep";

export type RecapLedgerItem = {
  colorToken: RecapColorToken;
  count: number;
  label: "shaky" | "strong" | "tomorrow";
};

export type RecapMoment = {
  detail: string;
  key: string;
  source: string;
  title: string;
};

export type RecapViewModel = {
  headline: string;
  ledger: RecapLedgerItem[];
  moments: RecapMoment[];
  nextReview?: {
    label: string;
    when: string;
  };
  partialReasonCopy?: string;
  summary: string;
};

export type RecapModelInput = {
  conceptStatuses: Record<string, ConceptStatus>;
  now: Date;
  partialReason?: AgentTerminalSessionReason;
  recap?: SessionRecap;
  studySet?: StudySet;
  terminalReason?: AgentTerminalSessionReason;
};

const EMPTY_LEDGER: RecapLedgerItem[] = [
  { colorToken: "sageDeep", count: 0, label: "strong" },
  { colorToken: "ochre", count: 0, label: "shaky" },
  { colorToken: "plumVivid", count: 0, label: "tomorrow" },
];

const PARTIAL_REASON_LABELS: Record<AgentTerminalSessionReason, string> = {
  cost_budget: "cost limit",
  drained: "service drain",
  durability_degraded: "storage degradation",
  partial_stage_success: "partial provider result",
  provider_auth_failed: "provider authentication failure",
  provider_cancelled: "provider cancellation",
  provider_malformed_stream: "malformed provider response",
  provider_network_disconnect: "provider disconnect",
  provider_rate_limited: "provider rate limit",
  provider_timeout: "provider timeout",
  rate_limit: "rate limit",
  rollback: "session rollback",
  session_cap: "session cap",
  slow_client: "connection too slow",
  tool_executor_failure: "tool failure",
  turn_cap: "time cap",
};

export function recapModel(input: RecapModelInput): RecapViewModel {
  const partialReason = input.partialReason ?? input.terminalReason;
  if (!input.recap) {
    if (partialReason) {
      return {
        headline: "Session ended before recap",
        ledger: EMPTY_LEDGER.map((item) => ({ ...item })),
        moments: [],
        partialReasonCopy: `The session ended early (${PARTIAL_REASON_LABELS[partialReason]}). No source-grounded recap was returned.`,
        summary: "Nothing has been presented as completed or scheduled.",
      };
    }
    return {
      headline: "No finished session yet",
      ledger: EMPTY_LEDGER.map((item) => ({ ...item })),
      moments: [],
      summary: "Finish a session to see its source-grounded recap here.",
    };
  }

  const projection = input.studySet
    ? recapPlanFromSessionEvents({
        conceptStatuses: input.conceptStatuses,
        now: input.now,
        recap: input.recap,
        studySet: input.studySet,
      })
    : undefined;
  // The recap event is authoritative for completed-session counts and source
  // moments. The planner projection may have no concepts when the current
  // library contract is metadata-only, so use it only for a supported review
  // schedule rather than letting it erase real recap arrays.
  const recap = input.recap;
  const stats = recapStats(recap);
  const review = projection?.reviewPlan[0];

  return {
    headline: recap.headline,
    ledger: [
      { colorToken: "sageDeep", count: stats[0]?.topics ?? 0, label: "strong" },
      { colorToken: "ochre", count: stats[1]?.topics ?? 0, label: "shaky" },
      { colorToken: "plumVivid", count: stats[2]?.topics ?? 0, label: "tomorrow" },
    ],
    moments: recap.sourceMoments.map((moment, index) => ({
      detail: moment.source.excerpt,
      key: `${moment.source.sourceId ?? moment.source.label}:${moment.source.span ?? "source"}:${index}`,
      source: moment.source.label,
      title: moment.text,
    })),
    nextReview: review
      ? {
          label: review.label,
          when: review.intervalLabel,
        }
      : undefined,
    partialReasonCopy: partialReason
      ? `The session ended early (${PARTIAL_REASON_LABELS[partialReason]}). This recap covers what was completed.`
      : undefined,
    summary: recap.summary,
  };
}
