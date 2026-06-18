import { Icon } from "@viva/ui-web";
import type { ComponentProps } from "react";

type IconName = ComponentProps<typeof Icon>["name"];

/**
 * Rounded ivory pill with a small lavender glyph. Lifts a touch on hover and
 * shows a clear focus ring. Used for the three opening suggestions.
 */
export function SuggestionChip({
  label,
  icon = "spark4",
  onClick,
}: {
  label: string;
  icon?: IconName;
  onClick?: () => void;
}) {
  return (
    <button className="viva-chip" onClick={onClick} type="button">
      <Icon
        className="viva-chip__icon"
        color="var(--viva-amethyst)"
        name={icon}
        size={14}
        strokeWidth={1.5}
      />
      {label}
    </button>
  );
}
