"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Layer 1 — the static, high-fidelity muse artwork. This is brand illustration,
 * not something drawn in code. We stage it: object-fit cover keeps the profile
 * on the left third, a soft radial glow lifts readability behind the central UI,
 * and a gentle top/bottom vignette embeds it in the parchment page.
 *
 * `FRONTEND-007`: self-hosted, intrinsically-sized art with a real,
 * state-driven PNG fallback. A native `<picture>` selects its `<source>`
 * by declared `type` support at selection time, not by whether the chosen
 * resource actually decodes — so a WebP `<source>` that is undecodable
 * (corrupt bytes, a broken CDN response, ...) still fires the `<img>`'s
 * `error` event, but the browser never re-runs source selection on its own
 * unless the source set itself changes. This client component listens for
 * that real decode error and removes the failed WebP `<source>`, which
 * makes the browser re-run `<picture>` selection and load the PNG `<img>`
 * src instead.
 *
 * The server-rendered HTML already contains the `<picture>`/`<img>`, so the
 * browser's own HTML parser can start — and, on a fast failure like
 * corrupt bytes, finish — the image request before React finishes
 * hydrating and attaches the `onError` listener below; a real SSR race,
 * not a hypothetical one. The mount effect covers that case by checking
 * the standard "already tried and already failed" signal
 * (`complete && naturalWidth === 0`) once hydration does run; `onError`
 * covers a failure that happens after hydration has already attached it.
 *
 * `width`/`height` are the real intrinsic pixel dimensions of both
 * `viva-muse.png` and `viva-muse.webp` (1672x941), so the browser can
 * reserve layout space before either image decodes.
 */
export function MuseBackdrop() {
  const [webpFailed, setWebpFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth === 0) {
      setWebpFailed(true);
    }
  }, []);

  return (
    <div aria-hidden="true" className="viva-muse">
      <picture>
        {!webpFailed && <source srcSet="/viva-muse.webp" type="image/webp" />}
        <img
          alt=""
          className="viva-muse__img"
          decoding="async"
          fetchPriority="high"
          height={941}
          onError={() => setWebpFailed(true)}
          ref={imgRef}
          src="/viva-muse.png"
          width={1672}
        />
      </picture>
      <div className="viva-muse__glow" />
      <div className="viva-muse__vignette" />
    </div>
  );
}
