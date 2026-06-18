import { Icon } from "@viva/ui-web";

/** A small inlaid source capsule, e.g. "Lecture 5 · Slide 18". */
export function SourceChip({ label }: { label: string }) {
  return (
    <span className="source-chip">
      <Icon color="var(--viva-amethyst)" name="book" size={13} strokeWidth={1.6} />
      {label}
    </span>
  );
}
