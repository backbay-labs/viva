import { useEffect, useId, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";

import { sparkPathD } from "@/components/brand";
import { VivaText } from "@/components/type";
import { colors, fonts, space } from "@/theme/tokens";

export type OrbState = "complete" | "correcting" | "listening" | "ready" | "thinking";

const labels: Record<OrbState, string> = {
  complete: "Session complete",
  correcting: "Correction ready",
  listening: "Listening",
  ready: "Ready",
  thinking: "Reading your answer",
};

/**
 * The orb is an eclipse: a deep aubergine core brightening toward a luminous
 * rim, held by a thin corona and dissolving into the vellum through a
 * state-tinted halo. Gradients are SVG so the circle clips identically on
 * iOS, Android, and web.
 */
type OrbPalette = {
  corona: string;
  halo: string;
  orbit: string;
  sphere: readonly [string, string, string, string];
};

const palettes: Record<OrbState, OrbPalette> = {
  complete: {
    corona: "rgba(255, 250, 240, 0.92)",
    halo: "#D9C08F",
    orbit: "rgba(189, 154, 85, 0.34)",
    sphere: ["#241537", "#372058", "#5F4287", "#9B7FC4"],
  },
  correcting: {
    corona: "rgba(255, 250, 240, 0.9)",
    halo: "#DDBE8E",
    orbit: "rgba(189, 154, 85, 0.38)",
    sphere: ["#2A1734", "#3F2450", "#6B4478", "#A583B4"],
  },
  listening: {
    corona: "rgba(250, 246, 255, 0.95)",
    halo: "#B9A3E0",
    orbit: "rgba(122, 91, 166, 0.4)",
    sphere: ["#281543", "#3B2260", "#6A4699", "#B394DD"],
  },
  ready: {
    corona: "rgba(255, 249, 238, 0.94)",
    halo: "#E8C88A",
    orbit: "rgba(189, 154, 85, 0.4)",
    sphere: ["#241335", "#351D4F", "#5C3A82", "#A182C9"],
  },
  thinking: {
    corona: "rgba(252, 247, 244, 0.8)",
    halo: "#CDB6CF",
    orbit: "rgba(122, 91, 166, 0.32)",
    sphere: ["#2E1C3D", "#452B57", "#77558A", "#A98BB8"],
  },
};

const breathingByState: Record<OrbState, { exhale: number; inhale: number } | null> = {
  complete: null,
  correcting: null,
  listening: { exhale: 760, inhale: 900 },
  ready: { exhale: 2300, inhale: 2600 },
  thinking: { exhale: 1300, inhale: 1500 },
};

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => subscription.remove();
  }, []);

  return reduced;
}

export function VoiceOrb({ size = 168, state = "ready" }: { size?: number; state?: OrbState }) {
  const gradientId = `orb${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const motion = useRef(new Animated.Value(0.55)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();

  const canvas = Math.round(size * 1.62);
  const center = canvas / 2;
  const sphereRadius = size / 2;
  const orbitRadius = sphereRadius * 1.24;
  const listening = state === "listening";
  const palette = palettes[state];

  useEffect(() => {
    const breathing = reducedMotion ? null : breathingByState[state];
    if (!breathing) {
      motion.setValue(0.55);
      return;
    }
    motion.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(motion, {
          duration: breathing.inhale,
          easing: Easing.inOut(Easing.sin),
          toValue: 1,
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(motion, {
          duration: breathing.exhale,
          easing: Easing.inOut(Easing.sin),
          toValue: 0,
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [motion, reducedMotion, state]);

  useEffect(() => {
    if (reducedMotion || state !== "thinking") {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        duration: 9000,
        easing: Easing.linear,
        toValue: 1,
        useNativeDriver: Platform.OS !== "web",
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      spin.setValue(0);
    };
  }, [reducedMotion, spin, state]);

  const glowOpacity = motion.interpolate({
    inputRange: [0, 1],
    outputRange: [listening ? 0.66 : 0.78, 1],
  });
  const glowScale = motion.interpolate({
    inputRange: [0, 1],
    outputRange: [0.965, listening ? 1.09 : 1.045],
  });
  const coreScale = motion.interpolate({
    inputRange: [0, 1],
    outputRange: [0.995, listening ? 1.03 : 1.015],
  });
  const sparkOpacity = motion.interpolate({ inputRange: [0, 1], outputRange: [0.84, 1] });
  const spinDeg = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <View
      accessibilityLabel={`Viva voice state: ${labels[state]}`}
      accessibilityRole="image"
      style={[styles.frame, { height: canvas, width: canvas }]}
    >
      <Animated.View
        style={[styles.layer, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]}
      >
        <Svg height={canvas} width={canvas}>
          <Defs>
            <RadialGradient id={`${gradientId}Glow`}>
              <Stop offset="0" stopColor={palette.halo} stopOpacity="0.5" />
              <Stop offset="0.58" stopColor={palette.halo} stopOpacity="0.44" />
              <Stop offset="0.7" stopColor={palette.halo} stopOpacity="0.3" />
              <Stop offset="0.82" stopColor={palette.halo} stopOpacity="0.14" />
              <Stop offset="0.92" stopColor={palette.halo} stopOpacity="0.05" />
              <Stop offset="1" stopColor={palette.halo} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={center} cy={center} fill={`url(#${gradientId}Glow)`} r={center} />
        </Svg>
      </Animated.View>
      <Animated.View style={[styles.layer, { transform: [{ rotate: spinDeg }] }]}>
        <Svg height={canvas} width={canvas}>
          <Circle
            cx={center}
            cy={center}
            fill="none"
            r={orbitRadius}
            stroke={palette.orbit}
            strokeDasharray="0.4 7.4"
            strokeLinecap="round"
            strokeWidth={1.1}
          />
        </Svg>
      </Animated.View>
      <Animated.View style={{ transform: [{ scale: coreScale }] }}>
        <Svg height={size} width={size}>
          <Defs>
            <RadialGradient id={`${gradientId}Sphere`} r="58%">
              <Stop offset="0" stopColor={palette.sphere[0]} />
              <Stop offset="0.5" stopColor={palette.sphere[1]} />
              <Stop offset="0.8" stopColor={palette.sphere[2]} />
              <Stop offset="1" stopColor={palette.sphere[3]} />
            </RadialGradient>
            <RadialGradient id={`${gradientId}Bloom`}>
              <Stop offset="0" stopColor="#C9AEE8" stopOpacity="0.4" />
              <Stop offset="0.55" stopColor="#C9AEE8" stopOpacity="0.13" />
              <Stop offset="1" stopColor="#C9AEE8" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle
            cx={sphereRadius}
            cy={sphereRadius}
            fill={`url(#${gradientId}Sphere)`}
            r={sphereRadius}
          />
          <Circle
            cx={sphereRadius}
            cy={sphereRadius}
            fill="none"
            r={sphereRadius - 1}
            stroke={palette.corona}
            strokeWidth={1.4}
          />
          <Circle
            cx={sphereRadius}
            cy={sphereRadius}
            fill={`url(#${gradientId}Bloom)`}
            r={sphereRadius * 0.46}
          />
        </Svg>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.layer, styles.sparkLayer, { opacity: sparkOpacity }]}
      >
        <Svg height={size * 0.24} viewBox="0 0 20 20" width={size * 0.24}>
          <Path d={sparkPathD(10, 10, 9)} fill="#FFFBF3" />
        </Svg>
      </Animated.View>
    </View>
  );
}

/**
 * Hairline flow-lines and spark accents that sit behind the home orb. Lines
 * fade out before they reach the glow so nothing ever crosses the sphere.
 */
export function OrbBackdrop() {
  const gradientId = `flow${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg height="100%" preserveAspectRatio="xMidYMid slice" viewBox="0 0 360 300" width="100%">
        <Defs>
          <LinearGradient id={`${gradientId}Left`} x1="0" x2="1" y1="0" y2="0">
            <Stop offset="0" stopColor={colors.gold} stopOpacity="0.5" />
            <Stop offset="0.7" stopColor={colors.gold} stopOpacity="0.28" />
            <Stop offset="1" stopColor={colors.gold} stopOpacity="0" />
          </LinearGradient>
          <LinearGradient id={`${gradientId}Right`} x1="0" x2="1" y1="0" y2="0">
            <Stop offset="0" stopColor={colors.gold} stopOpacity="0" />
            <Stop offset="0.3" stopColor={colors.gold} stopOpacity="0.28" />
            <Stop offset="1" stopColor={colors.gold} stopOpacity="0.5" />
          </LinearGradient>
        </Defs>
        <Path
          d="M -6 152 C 40 140 68 156 88 148"
          fill="none"
          stroke={`url(#${gradientId}Left)`}
          strokeWidth={1}
        />
        <Path
          d="M -6 170 C 48 178 72 164 84 166"
          fill="none"
          opacity={0.55}
          stroke={`url(#${gradientId}Left)`}
          strokeWidth={1}
        />
        <Path
          d="M 272 138 C 296 128 320 144 366 136"
          fill="none"
          stroke={`url(#${gradientId}Right)`}
          strokeWidth={1}
        />
        <Path
          d="M 276 160 C 298 166 322 152 366 158"
          fill="none"
          opacity={0.55}
          stroke={`url(#${gradientId}Right)`}
          strokeWidth={1}
        />
        <Path d={sparkPathD(64, 92, 6.5)} fill={colors.gold} opacity={0.7} />
        <Path d={sparkPathD(298, 84, 4.5)} fill={colors.gold} opacity={0.55} />
        <Path d={sparkPathD(286, 214, 3.5)} fill={colors.gold} opacity={0.45} />
        <Circle cx={42} cy={212} fill={colors.gold} opacity={0.4} r={1.4} />
        <Circle cx={324} cy={172} fill={colors.gold} opacity={0.35} r={1.2} />
      </Svg>
    </View>
  );
}

const waveformBars = [
  4, 7, 5, 10, 8, 14, 11, 18, 15, 24, 20, 30, 26, 38, 32, 44, 36, 46, 40, 34, 42, 28, 35, 23, 29,
  18, 24, 14, 19, 11, 15, 8, 10, 6,
].map((height, index) => ({
  height,
  id: `voice-bar-${String(index + 1).padStart(2, "0")}`,
  opacity: 0.38 + ((index * 11) % 5) * 0.09,
  phase: [0, 2, 1, 3][index % 4] as number,
}));

const edgeDots = Array.from({ length: 8 }, (_, index) => ({
  id: `voice-dot-${String(index + 1).padStart(2, "0")}`,
}));

export function VoiceWaveform({ active = true }: { active?: boolean }) {
  const phases = useRef(Array.from({ length: 4 }, () => new Animated.Value(0.5))).current;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!active || reducedMotion) {
      for (const phase of phases) {
        phase.setValue(0.5);
      }
      return;
    }

    const loops = phases.map((phase, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 130),
          Animated.timing(phase, {
            duration: 480 + index * 70,
            easing: Easing.inOut(Easing.sin),
            toValue: 1,
            useNativeDriver: Platform.OS !== "web",
          }),
          Animated.timing(phase, {
            duration: 560 + index * 80,
            easing: Easing.inOut(Easing.sin),
            toValue: 0.2,
            useNativeDriver: Platform.OS !== "web",
          }),
        ]),
      ),
    );
    for (const loop of loops) {
      loop.start();
    }
    return () => {
      for (const loop of loops) {
        loop.stop();
      }
    };
  }, [active, phases, reducedMotion]);

  const scales = phases.map((phase) =>
    phase.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
  );

  return (
    <View accessibilityLabel="Live voice level" style={styles.waveform}>
      <View style={styles.dotRow}>
        {edgeDots.map((dot) => (
          <View key={dot.id} style={styles.dot} />
        ))}
      </View>
      {waveformBars.map((bar) => (
        <Animated.View
          key={bar.id}
          style={[
            styles.bar,
            {
              height: bar.height,
              opacity: active ? bar.opacity : 0.2,
              transform: [{ scaleY: scales[bar.phase] }],
            },
          ]}
        />
      ))}
      <View style={styles.dotRow}>
        {edgeDots.map((dot) => (
          <View key={dot.id} style={styles.dot} />
        ))}
      </View>
    </View>
  );
}

export function VoiceStateLabel({ children }: { children: string }) {
  return (
    <VivaText style={styles.stateText} tone="plum" variant="caption">
      {children}
    </VivaText>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.plumVivid,
    borderRadius: 1,
    width: 2,
  },
  dot: {
    backgroundColor: colors.plumVivid,
    borderRadius: 1.25,
    height: 2.5,
    opacity: 0.2,
    width: 2.5,
  },
  dotRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 5,
    marginHorizontal: space.sm,
  },
  frame: {
    alignItems: "center",
    justifyContent: "center",
  },
  layer: {
    alignItems: "center",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sparkLayer: {
    zIndex: 2,
  },
  stateText: {
    fontFamily: fonts.bodySemibold,
    letterSpacing: 0.4,
    textAlign: "center",
  },
  waveform: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2.5,
    height: 52,
    justifyContent: "center",
    width: "100%",
  },
});
