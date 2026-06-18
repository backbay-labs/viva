import type { ReactNode } from "react";

/**
 * A small, refined marginalia action. Quiet by default; one "primary" amethyst
 * variant for the single emphasized action. Icons are passed in as nodes so this
 * stays decoupled from the icon set.
 */
export function SessionActionButton({
  disabled = false,
  label,
  onClick,
  variant = "default",
  leading,
  trailing,
}: {
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  variant?: "default" | "primary";
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      className={`session-action session-action--${variant}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {leading ? <span className="session-action__icon">{leading}</span> : null}
      <span className="session-action__label">{label}</span>
      {trailing ? (
        <span className="session-action__icon session-action__icon--trail">{trailing}</span>
      ) : null}
    </button>
  );
}
