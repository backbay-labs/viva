import type { SessionRecap, StudySet } from "@viva/core";

export type RecapStat = {
  color: string;
  label: string;
  pct: number;
  topics: number;
};

export function uploadPreviewSummary(studySet: StudySet): {
  conceptLabel: string;
  overflowLabel: string;
} {
  return {
    conceptLabel:
      studySet.concepts.length > 0
        ? `${studySet.concepts.length} preview concepts`
        : "Awaiting real concept extraction",
    overflowLabel:
      studySet.concepts.length > 8 ? `+${studySet.concepts.length - 8} more` : "Extraction pending",
  };
}

export function recapStats(recap: SessionRecap): RecapStat[] {
  const total = Math.max(
    1,
    recap.strongConcepts.length + recap.shakyConcepts.length + recap.reviewLater.length,
  );
  const pct = (count: number) => Math.round((count / total) * 100);

  return [
    {
      color: "var(--sage)",
      label: "Strong",
      pct: pct(recap.strongConcepts.length),
      topics: recap.strongConcepts.length,
    },
    {
      color: "var(--amber)",
      label: "Shaky",
      pct: pct(recap.shakyConcepts.length),
      topics: recap.shakyConcepts.length,
    },
    {
      color: "var(--plum)",
      label: "Review tomorrow",
      pct: pct(recap.reviewLater.length),
      topics: recap.reviewLater.length,
    },
  ];
}

export function correctionQuote(answer: string): string {
  return answer.trim().length > 0 ? `"${answer}"` : "No browser transcript captured";
}
