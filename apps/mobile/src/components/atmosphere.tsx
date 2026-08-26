import { useEffect, useId, useRef } from "react";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import {
  gaussianStops,
  VIGNETTE,
  VIGNETTE_RADIUS,
  WELL,
  WELL_RADIUS,
} from "@/components/atmosphere-geometry";
import { createReadyLatch, type ReadyLatch } from "@/components/atmosphere-readiness";

// Relative, not "@/assets/...": the tsconfig maps @/assets/* but nothing in the
// app imports through it yet, so Metro's resolution of that branch is unproven.
// A relative asset path is guaranteed. Private to this module: what the current
// tier needs in order to paint is the tier's own business, and Act 2 changes it.
const VELLUM_PLATE = require("../../assets/images/vellum-plate.webp");

const WELL_STOPS = gaussianStops(WELL.peakOpacity, 5);

// How long a caller will wait on the atmosphere before opening anyway. Covers a
// plate that neither decodes nor errors, and caps web cold start, where there is
// no native splash behind us and first paint is blocked on a 318 KB webp.
const READY_DEADLINE_MS = 3000;

export type VivaAtmosphereProps = {
  /**
   * Called once, when the ground is on screen — or when waiting for it stopped
   * being worth it.
   *
   * The root layout holds the splash on this so the handoff is seamless:
   * opening on fonts alone flashes flat canvas first, which is the exact
   * impression this work exists to remove. It deliberately says nothing about
   * *what* was being waited on — Act 1 decodes a baked plate, Act 2 will commit
   * a shader's first frame — so the caller does not change when the tier does.
   *
   * Availability is not readiness, and that distinction is the whole point of
   * this prop. `Asset.downloadAsync()` resolves once the file is local, which on
   * native says nothing about whether the 1242x2688 plate has been decoded and
   * drawn; the splash lifted over a plate still decoding. So the signal comes
   * from the <Image> itself, and the atmosphere has to be mounted while the
   * caller is still waiting — the plate cannot decode before it is mounted.
   */
  onReady?: () => void;
};

/**
 * The ground every screen sits on.
 *
 * Act 1 (this): a baked plate carrying the material and the light, plus a
 * screen-relative readability well and vignette in SVG. No Skia, no new
 * dependency. Act 2 replaces the plate with the live shader and keeps this
 * component's shape; this implementation then survives as the fallback tier for
 * web and for devices that miss the frame-time gate, so it stays exercised.
 *
 * Purely decorative: hidden from assistive technology and never touchable.
 */
export function VivaAtmosphere({ onReady }: VivaAtmosphereProps) {
  const gradientId = `viva${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // Read the callback through a ref so a caller that passes a fresh closure on
  // every render cannot restart the deadline underneath itself.
  const latestOnReady = useRef(onReady);
  useEffect(() => {
    latestOnReady.current = onReady;
  }, [onReady]);

  // One latch per mount rather than one per component: cancelling it is how
  // unmount is honoured, and React re-runs mount effects (StrictMode does it on
  // every mount in development), so a latch that outlived the effect would come
  // back sealed shut.
  const latch = useRef<ReadyLatch | null>(null);
  useEffect(() => {
    const pending = createReadyLatch(() => latestOnReady.current?.(), READY_DEADLINE_MS);
    latch.current = pending;
    return () => {
      latch.current = null;
      pending.cancel();
    };
  }, []);

  // Both tiers deliver the image callbacks on a later tick than this effect, so
  // the latch is always in place by the time one arrives. If some tier ever
  // reported synchronously during commit the signal would be dropped and the
  // deadline would release instead — late, never wedged.
  const signalReady = () => {
    latch.current?.signal();
  };

  return (
    // accessibilityElementsHidden is iOS-only and importantForAccessibility is
    // Android-only; react-native-web forwards neither. aria-hidden covers the
    // web tier, which is not a side-channel here — it is the fallback path
    // low-end devices take too, so a hole in it is a hole in shipped behaviour.
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Image
        onError={(event) => {
          // A plate that cannot be decoded must not wedge the splash: the app
          // opens on flat canvas, which is far better than not opening at all.
          console.warn(
            "[viva] the vellum plate failed to load; opening on flat canvas.",
            event.nativeEvent,
          );
          signalReady();
        }}
        onLoad={signalReady}
        resizeMode="cover"
        source={VELLUM_PLATE}
        style={styles.plate}
      />
      <Svg height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          {/*
            Both radii are supplied on purpose. rx/ry are a react-native-svg
            native extension and a DOM <radialGradient> has none, so the browser
            drops them and falls back to the SVG default r = 50%; r is what web
            actually paints with. Native ignores r whenever rx is present
            (`rx: rx || r`), so native output is unchanged. Removing either one
            silently breaks one of the two tiers.
          */}
          <RadialGradient
            cx={`${WELL.cx * 100}%`}
            cy={`${WELL.cy * 100}%`}
            id={`${gradientId}Well`}
            r={`${WELL_RADIUS * 100}%`}
            rx={`${WELL.rx * 100}%`}
            ry={`${WELL.ry * 100}%`}
          >
            {WELL_STOPS.map((stop) => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor={WELL.color}
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
          <RadialGradient
            cx={`${VIGNETTE.cx * 100}%`}
            cy={`${VIGNETTE.cy * 100}%`}
            id={`${gradientId}Vignette`}
            r={`${VIGNETTE_RADIUS * 100}%`}
            rx={`${VIGNETTE.rx * 100}%`}
            ry={`${VIGNETTE.ry * 100}%`}
          >
            <Stop offset={VIGNETTE.innerStop} stopColor={VIGNETTE.color} stopOpacity={0} />
            <Stop offset={1} stopColor={VIGNETTE.color} stopOpacity={VIGNETTE.edgeOpacity} />
          </RadialGradient>
        </Defs>
        <Rect fill={`url(#${gradientId}Well)`} height="100%" width="100%" />
        <Rect fill={`url(#${gradientId}Vignette)`} height="100%" width="100%" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: {
    // The insets alone are not enough: react-native-web writes the source's
    // intrinsic size (1242x2688) as an inline style whenever the passed style
    // omits width/height, and that beats the insets — the plate then renders at
    // its natural size and `cover` crops a magnified corner. Native sizes from
    // the insets alone, so the plate must state both. Do not "simplify" this
    // back to style={StyleSheet.absoluteFill} on the <Image>.
    //
    // Spreading absoluteFill rather than absoluteFillObject is also deliberate:
    // React Native 0.86 removed absoluteFillObject from core, so spreading it
    // would be `...undefined` and would drop position:absolute on iOS and
    // Android while looking fine on web.
    ...StyleSheet.absoluteFill,
    height: "100%",
    width: "100%",
  },
});
