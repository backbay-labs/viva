import { useId } from "react";
import { Image, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { gaussianStops, VIGNETTE, WELL } from "@/components/atmosphere-geometry";

// Relative, not "@/assets/...": the tsconfig maps @/assets/* but nothing in the
// app imports through it yet, so Metro's resolution of that branch is unproven.
// A relative asset path is guaranteed. Exported so _layout.tsx preloads the same
// module reference rather than duplicating the path.
export const VELLUM_PLATE = require("../../assets/images/vellum-plate.webp");

const WELL_STOPS = gaussianStops(WELL.peakOpacity, 5);

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
          <RadialGradient
            cx={`${WELL.cx * 100}%`}
            cy={`${WELL.cy * 100}%`}
            id={`${gradientId}Well`}
            rx={`${WELL.rx * 100}%`}
            ry={`${WELL.ry * 100}%`}
          >
            {WELL_STOPS.map((stop) => (
              <Stop
                key={stop.offset}
                offset={stop.offset}
                stopColor="#FFFDFA"
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
          <RadialGradient cx="50%" cy="50%" id={`${gradientId}Vignette`} rx="74%" ry="64%">
            <Stop offset={VIGNETTE.innerStop} stopColor="#2B1D34" stopOpacity={0} />
            <Stop offset={1} stopColor="#2B1D34" stopOpacity={VIGNETTE.edgeOpacity} />
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
    // back to a bare StyleSheet.absoluteFill.
    ...StyleSheet.absoluteFill,
    height: "100%",
    width: "100%",
  },
});
