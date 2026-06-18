/**
 * Layer 1 — the static, high-fidelity muse artwork. This is brand illustration,
 * not something drawn in code. We stage it: object-fit cover keeps the profile
 * on the left third, a soft radial glow lifts readability behind the central UI,
 * and a gentle top/bottom vignette embeds it in the parchment page.
 */
export function MuseBackdrop() {
  return (
    <div aria-hidden="true" className="viva-muse">
      <picture>
        <source srcSet="/viva-muse.webp" type="image/webp" />
        <img
          alt=""
          className="viva-muse__img"
          decoding="async"
          fetchPriority="high"
          src="/viva-muse.png"
        />
      </picture>
      <div className="viva-muse__glow" />
      <div className="viva-muse__vignette" />
    </div>
  );
}
