/** A muted ochre spaced-repetition verdict, e.g. "Shaky · bring back tomorrow". */
export function StatusChip({ label }: { label: string }) {
  return (
    <span className="status-chip">
      <span className="status-chip__dot" />
      {label}
    </span>
  );
}
