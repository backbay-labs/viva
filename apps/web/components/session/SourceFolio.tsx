import { Icon } from "@viva/ui-web";
import { SessionActionButton } from "./SessionActionButton";
import type { Question } from "./session-data";

/**
 * Source reveal — the right margin becomes a concise source folio for active
 * recall: citation, the relevant heading, a small schematic, the excerpt, and a
 * way back. Deliberately not a PDF viewer.
 */
export function SourceFolio({ question, onBack }: { question: Question; onBack: () => void }) {
  return (
    <div className="folio">
      <p className="folio__ref">{question.sourceRef}</p>
      <p className="folio__subtitle">{question.sourceSubtitle}</p>
      <FolioDiagram />
      <p className="folio__excerpt">{question.excerpt}</p>
      <p className="folio__footer">{question.sourceFooter}</p>
      <SessionActionButton
        label="Back to question"
        leading={
          <span className="flip-x">
            <Icon color="var(--viva-amethyst)" name="arrow" size={15} strokeWidth={1.6} />
          </span>
        }
        onClick={onBack}
      />
    </div>
  );
}

/** A small, abstract membrane schematic — a refined illustration block, not data. */
function FolioDiagram() {
  return (
    <div className="folio__diagram" aria-hidden="true">
      <svg fill="none" height="76" viewBox="0 0 232 76" width="100%">
        <title>Membrane schematic</title>
        {/* inner mitochondrial membrane band */}
        <rect height="20" rx="10" stroke="rgba(93,52,127,0.5)" width="208" x="12" y="28" />
        {/* electron transport complexes */}
        <circle cx="56" cy="38" fill="rgba(222,208,241,0.8)" r="7" stroke="rgba(93,52,127,0.65)" />
        <circle cx="96" cy="38" fill="rgba(222,208,241,0.8)" r="7" stroke="rgba(93,52,127,0.65)" />
        <circle cx="136" cy="38" fill="rgba(222,208,241,0.8)" r="7" stroke="rgba(93,52,127,0.65)" />
        {/* ATP synthase — rotor on a stalk */}
        <path d="M188 28v18" stroke="rgba(93,52,127,0.72)" strokeWidth="1.5" />
        <circle cx="188" cy="54" fill="rgba(129,84,189,0.85)" r="8" />
        {/* proton flux arrows (gold), crossing the membrane */}
        <path
          d="M168 14c0 8 4 12 4 20s-4 12-4 20"
          stroke="rgba(176,124,52,0.88)"
          strokeDasharray="2 4"
          strokeLinecap="round"
        />
        <path d="M188 60l4 8M188 60l-4 6" stroke="rgba(176,124,52,0.9)" strokeLinecap="round" />
      </svg>
    </div>
  );
}
