import { Icon } from "@viva/ui-web";
import { type FormEvent, useRef } from "react";

/**
 * The central command surface — a large, refined pill. Voice-first on the left
 * (mic), an elegant placeholder in the middle, and an amethyst submit on the
 * right. It is a real, keyboard-focusable <form>; both the mic and the submit
 * hand the current query up to the parent to enter the session.
 *
 * onActiveChange reports whether the surface is hovered or focused, so the hero
 * can quicken the living-manuscript layer while the student is engaging with it.
 */
export function CommandSurface({
  value,
  onChange,
  onSubmit,
  onActiveChange,
  placeholder = "Where should Viva begin?",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onActiveChange?: (active: boolean) => void;
  placeholder?: string;
}) {
  const hovered = useRef(false);
  const focused = useRef(false);

  function report() {
    onActiveChange?.(hovered.current || focused.current);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <form
      className="viva-command"
      onBlur={() => {
        focused.current = false;
        report();
      }}
      onFocus={() => {
        focused.current = true;
        report();
      }}
      onMouseEnter={() => {
        hovered.current = true;
        report();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        report();
      }}
      onSubmit={handleSubmit}
    >
      <button
        aria-label="Answer out loud"
        className="viva-command__mic"
        onClick={() => onSubmit(value)}
        type="button"
      >
        <Icon color="var(--viva-amethyst-deep)" name="mic" size={20} strokeWidth={1.5} />
      </button>
      <input
        aria-label="Where should Viva begin?"
        className="viva-command__input"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      <button aria-label="Start studying" className="viva-command__submit" type="submit">
        <Icon color="var(--viva-paper)" name="arrow" size={19} strokeWidth={1.8} />
      </button>
    </form>
  );
}
