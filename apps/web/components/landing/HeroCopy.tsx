/**
 * The real, accessible hero copy. The headline is a genuine <h1>; "viva voce."
 * is set in italic serif as a quiet accent. Nothing here depends on the
 * background artwork for meaning.
 */
export function HeroCopy() {
  return (
    <div className="viva-copy">
      <h1 className="viva-copy__headline">
        All you must know,
        <br />
        <em className="viva-copy__accent">viva voce.</em>
      </h1>
      <p className="viva-copy__sub">Speak until it stays.</p>
    </div>
  );
}
