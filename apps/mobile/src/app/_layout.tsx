import { installRuntimeGlobals } from "@/runtime/globals";

installRuntimeGlobals();

import { Cormorant_500Medium_Italic, Cormorant_600SemiBold } from "@expo-google-fonts/cormorant";
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from "@expo-google-fonts/hanken-grotesk";
import { Asset } from "expo-asset";
import { useFonts } from "expo-font";
import { DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { VELLUM_PLATE, VivaAtmosphere } from "@/components/atmosphere";
import { colors } from "@/theme/tokens";

void SplashScreen.preventAutoHideAsync();
void SystemUI.setBackgroundColorAsync(colors.canvas);

// React Navigation paints the navigator's own container from the theme, and its
// default background is an opaque rgb(242, 242, 242) that sits above the
// atmosphere. contentStyle only reaches the screen content, one level in, so
// without this the vellum is covered by a neutral grey and never shows at all.
// Imported from expo-router, which re-exports these: @react-navigation/native
// resolves above this repo, outside Metro's watchFolders, and fails to bundle.
const TRANSPARENT_NAV_THEME = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: "transparent" },
};

// How long the splash will wait on the plate before opening anyway. Also caps
// web cold start, where there is no native splash behind us and first paint is
// blocked on a 318 KB webp.
const PLATE_DECODE_DEADLINE_MS = 3000;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Cormorant_500Medium_Italic,
    Cormorant_600SemiBold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
  });
  const [plateReady, setPlateReady] = useState(false);

  // The splash background is already the vellum's base colour, so holding it
  // until the plate is decoded makes the handoff seamless. Hiding on fonts
  // alone flashes flat canvas first, which is the exact impression this work
  // exists to remove.
  //
  // The gate has to be total. A rejected download, a synchronous throw out of
  // Asset.fromModule, and a promise that simply never settles all end the same
  // way: the app opens on flat canvas, which is far better than an app that
  // never opens at all. Hence the deadline as well as the catch.
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
      deadline = setTimeout(resolve, PLATE_DECODE_DEADLINE_MS);
    });

    void Promise.race([decoded, timedOut]).finally(() => {
      if (active) setPlateReady(true);
    });

    return () => {
      active = false;
      clearTimeout(deadline);
    };
  }, []);

  const ready = (fontsLoaded || fontError) && plateReady;

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.root}>
        <VivaAtmosphere />
        <StatusBar style="dark" />
        <ThemeProvider value={TRANSPARENT_NAV_THEME}>
          <Stack
            screenOptions={{
              animation: "fade_from_bottom",
              contentStyle: { backgroundColor: "transparent" },
              gestureEnabled: true,
              headerShown: false,
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="session" options={{ gestureEnabled: false }} />
            <Stack.Screen name="recap" />
            <Stack.Screen name="library" />
          </Stack>
        </ThemeProvider>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
});
