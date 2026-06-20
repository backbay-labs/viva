import { Icon } from "@viva/ui-web";
import type { RefObject } from "react";
import type { SourceFolioProjection } from "../../lib/viva-session-projection";
import { SessionActionButton } from "./SessionActionButton";
import { SourceChip } from "./SourceChip";
import { StatusChip } from "./StatusChip";
import type { Question } from "./session-data";

/**
 * Source reveal - the right margin becomes a concise Source Folio for active
 * recall: citation, concept status, confidence, bounded excerpt, and a way to
 * challenge the citation. Deliberately not a PDF viewer.
 */
export function SourceFolio({
  question,
  sourceFolio,
  onBack,
  onChallenge,
  rootRef,
}: {
  question: Question;
  sourceFolio?: SourceFolioProjection;
  onBack: () => void;
  onChallenge?: () => void;
  rootRef?: RefObject<HTMLElement | null>;
}) {
  const folio = sourceFolio ?? sourceFolioFromQuestion(question);

  return (
    // tabIndex=-1 + aria-label so keyboard focus can land in this region when the
    // margin opens the folio, instead of falling to <body>.
    <section
      aria-label="Source folio"
      className="folio source-folio"
      data-source-state={folio.state}
      ref={rootRef}
      tabIndex={-1}
    >
      <p className="folio__subtitle">Source Folio</p>
      <p className="folio__ref">{folio.source.label}</p>
      <div className="source-folio__chips">
        <SourceChip label={folio.source.label} />
        <StatusChip label={folio.conceptStatus} />
      </div>
      <dl className="source-folio__facts">
        <div>
          <dt>Confidence</dt>
          <dd>{folio.confidenceLabel}</dd>
        </div>
        <div>
          <dt>Span</dt>
          <dd>{sourceSpanLabel(folio)}</dd>
        </div>
      </dl>
      <div className="source-folio__excerpt">
        <p>{folio.source.excerpt || "No bounded excerpt is available for this correction."}</p>
      </div>
      <p className="source-folio__caveat">{folio.caveat}</p>
      <p className="folio__footer">{folio.regionNavigation}</p>
      <SessionActionButton
        label={folio.challengeLabel}
        leading={<Icon color="var(--viva-amethyst)" name="pen" size={15} strokeWidth={1.6} />}
        onClick={onChallenge}
      />
      <SessionActionButton
        label="Back to question"
        leading={
          <span className="flip-x">
            <Icon color="var(--viva-amethyst)" name="arrow" size={15} strokeWidth={1.6} />
          </span>
        }
        onClick={onBack}
      />
    </section>
  );
}

function sourceFolioFromQuestion(question: Question): SourceFolioProjection {
  const hasSource = Boolean(question.excerpt.trim() && question.sourceRef.trim());
  return {
    caveat: hasSource
      ? question.sourceSubtitle || "Source citation is bounded to this question span."
      : "No bounded source_reference has arrived for this correction.",
    challengeLabel: hasSource ? "Challenge citation" : "Challenge unavailable source",
    conceptStatus: question.status || "Awaiting concept status",
    confidenceLabel: hasSource ? "Question source" : "Source unavailable",
    regionNavigation: "Document span only; exact page and bounding-box navigation is unverified.",
    source: {
      confidence: hasSource ? "high" : "low",
      excerpt: question.excerpt,
      label: question.sourceRef || "Source unavailable",
    },
    state: hasSource ? "present" : "unavailable",
  };
}

function sourceSpanLabel(folio: SourceFolioProjection): string {
  if (folio.source.documentId && folio.source.span) {
    return `${folio.source.documentId} · ${folio.source.span}`;
  }
  return folio.source.span ?? folio.source.documentId ?? "bounded span unavailable";
}
