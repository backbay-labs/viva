import { Spark } from "@viva/ui-web";

/**
 * Sparse top-left brand mark: "Viva" set in the elegant serif with a small
 * amethyst sparkle. No nav links — the landing hero stays intentionally bare.
 */
export function VivaWordmark() {
  return (
    <div className="viva-wordmark">
      <span className="viva-wordmark__text">Viva</span>
      <Spark className="viva-wordmark__spark" color="var(--viva-amethyst)" size={12} />
    </div>
  );
}
