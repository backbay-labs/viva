import { installRuntimeGlobals } from "@/runtime/globals";

installRuntimeGlobals();

import { Cormorant_500Medium_Italic, Cormorant_600SemiBold } from "@expo-google-fonts/cormorant";
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from "@expo-google-fonts/hanken-grotesk";
import { useFonts } from "expo-font";
import { DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { VivaAtmosphere } from "@/components/atmosphere";
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

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Cormorant_500Medium_Italic,
    Cormorant_600SemiBold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
  });
  // The splash background is already the vellum's base colour, so holding it
  // until the atmosphere can paint makes the handoff seamless. What that costs
  // — and which tier is doing the waiting — belongs to the atmosphere, not here.
  const [atmosphereReady, setAtmosphereReady] = useState(false);
  const markAtmosphereReady = useCallback(() => setAtmosphereReady(true), []);

  const ready = (fontsLoaded || fontError) && atmosphereReady;

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  // The atmosphere is mounted before it is ready, not after: a plate cannot
  // decode until it is on screen, so gating it on its own readiness would wait
  // for something that had not started. The loading state is therefore the real
  // ground rather than a bare base colour — and on web, where there is no
  // splash over us, that is what stands in for one.
  return (
    <GestureHandlerRootView style={styles.fill}>
      <View style={styles.root}>
        <VivaAtmosphere onReady={markAtmosphereReady} />
        {ready ? (
          <>
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
          </>
        ) : null}
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // The root view below already paints the base colour, and a second opaque
  // full-screen fill behind it is pure overdraw on exactly the low-end devices
  // this tier targets.
  fill: {
    flex: 1,
  },
  root: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
});
