export type AppConfig = {
  agentHttpUrl: string;
  agentWsUrl: string;
  restBearerToken: string | null;
  sessionToken: string | null;
  studySetId: string;
  userId: string;
  wsBearerToken: string | null;
  wsOrigin: string | null;
};

const DEFAULT_WS_URL = "ws://127.0.0.1:4318/ws";

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function httpFromWs(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/ws\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function runtimeExpoPublicEnv(): Record<string, string | undefined> {
  // Expo replaces EXPO_PUBLIC_* values only for direct, statically analyzable
  // property reads. Keep this object literal explicit; `process.env` passed as
  // a whole object silently falls back in native and exported bundles.
  return {
    EXPO_PUBLIC_VIVA_AGENT_HTTP_URL: process.env.EXPO_PUBLIC_VIVA_AGENT_HTTP_URL,
    EXPO_PUBLIC_VIVA_AGENT_WS_URL: process.env.EXPO_PUBLIC_VIVA_AGENT_WS_URL,
    EXPO_PUBLIC_VIVA_REST_BEARER_TOKEN: process.env.EXPO_PUBLIC_VIVA_REST_BEARER_TOKEN,
    EXPO_PUBLIC_VIVA_SESSION_TOKEN: process.env.EXPO_PUBLIC_VIVA_SESSION_TOKEN,
    EXPO_PUBLIC_VIVA_STUDY_SET_ID: process.env.EXPO_PUBLIC_VIVA_STUDY_SET_ID,
    EXPO_PUBLIC_VIVA_USER_ID: process.env.EXPO_PUBLIC_VIVA_USER_ID,
    EXPO_PUBLIC_VIVA_WS_BEARER_TOKEN: process.env.EXPO_PUBLIC_VIVA_WS_BEARER_TOKEN,
    EXPO_PUBLIC_VIVA_WS_ORIGIN: process.env.EXPO_PUBLIC_VIVA_WS_ORIGIN,
  };
}

export function loadAppConfig(env?: Record<string, string | undefined>): AppConfig {
  const resolvedEnv = env ?? runtimeExpoPublicEnv();
  const agentWsUrl = trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_AGENT_WS_URL) ?? DEFAULT_WS_URL;
  const agentHttpUrl =
    trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_AGENT_HTTP_URL)?.replace(/\/+$/, "") ??
    httpFromWs(agentWsUrl);
  return {
    agentHttpUrl,
    agentWsUrl,
    restBearerToken: trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_REST_BEARER_TOKEN),
    sessionToken: trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_SESSION_TOKEN),
    studySetId: trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_STUDY_SET_ID) ?? "biology-midterm",
    userId: trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_USER_ID) ?? "user-1",
    wsBearerToken: trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_WS_BEARER_TOKEN),
    wsOrigin: trimmed(resolvedEnv.EXPO_PUBLIC_VIVA_WS_ORIGIN),
  };
}
