import { Icon } from "@viva/ui-web";

/**
 * Small pill above the headline showing the active study set. Distinct from the
 * app-chrome ContextPill in @viva/ui-web — this one is tuned for the airy hero.
 */
export function ContextPill({
  items = ["Biology Midterm", "3 docs", "Exam Friday"],
}: {
  items?: string[];
}) {
  return (
    <span className="viva-context">
      <Icon className="viva-context__icon" color="var(--viva-amethyst)" name="layers" size={14} />
      {items.map((item, index) => (
        <span className="viva-context__item" key={item}>
          {index > 0 ? (
            <span aria-hidden="true" className="viva-context__dot">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </span>
  );
}
