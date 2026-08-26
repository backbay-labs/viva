import { Asset } from "expo-asset";
import { useEffect, useId, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import {
  gaussianStops,
  VIGNETTE,
  VIGNETTE_RADIUS,
  WELL,
  WELL_RADIUS,
} from "@/components/atmosphere-geometry";

// Relative, not "@/assets/...": the tsconfig maps @/assets/* but nothing in the
// app imports through it yet, so Metro's resolution of that branch is unproven.
// A relative asset path is guaranteed. Private to this module: what the current
// tier needs in order to paint is the tier's own business, and Act 2 changes it.
const VELLUM_PLATE = require("../../assets/images/vellum-plate.webp");

const WELL_STOPS = gaussianStops(WELL.peakOpacity, 5);

// How long a caller will wait on the atmosphere before opening anyway. Also
// caps web cold start, where there is no native splash behind us and first
// paint is blocked on a 318 KB webp.
const READY_DEADLINE_MS = 3000;

/**
 * Whether the atmosphere has everything it needs to paint its first frame.
 *
 * The root layout holds the splash on this so the handoff is seamless: opening
 * on fonts alone flashes flat canvas first, which is the exact impression this
 * work exists to remove. It deliberately says nothing about *what* is being
 * waited on — Act 1 decodes a baked plate, Act 2 will warm a shader, and the
 * caller should not have to change when that happens.
 *
 * The gate has to be total. A rejected download, a synchronous throw out of
 * Asset.fromModule, and a promise that simply never settles all end the same
 * way: the app opens on flat canvas, which is far better than an app that never
 * opens at all. Hence the deadline as well as the catch.
 */
export function useAtmosphereReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let deadline: ReturnType<typeof setTimeout>;

    // Promise.resolve().then(...) so a synchronous throw from fromModule
    // becomes a rejection this chain can catch, rather than escaping the effect.
    const decoded = Promise.resolve()
      .then(() => Asset.fromModule(VELLUM_PLATE).downloadAsync())
      .catch((error: unknown) => {
        console.warn("[viva] the vellum plate failed to load; opening on flat canvas.", error);
      });
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, READY_DEADLINE_MS);
    });

    void Promise.race([decoded, timedOut]).finally(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      clearTimeout(deadline);
    };
  }, []);

  return ready;
}

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
export function VivaAtmosphere() {
  const gradientId = `viva${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

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
      <Image resizeMode="cover" source={VELLUM_PLATE} style={styles.plate} />
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
