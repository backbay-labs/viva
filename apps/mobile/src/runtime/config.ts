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

export function loadAppConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AppConfig {
  const agentWsUrl = trimmed(env.EXPO_PUBLIC_VIVA_AGENT_WS_URL) ?? DEFAULT_WS_URL;
  const agentHttpUrl =
    trimmed(env.EXPO_PUBLIC_VIVA_AGENT_HTTP_URL)?.replace(/\/+$/, "") ?? httpFromWs(agentWsUrl);
  return {
    agentHttpUrl,
    agentWsUrl,
    restBearerToken: trimmed(env.EXPO_PUBLIC_VIVA_REST_BEARER_TOKEN),
    sessionToken: trimmed(env.EXPO_PUBLIC_VIVA_SESSION_TOKEN),
    studySetId: trimmed(env.EXPO_PUBLIC_VIVA_STUDY_SET_ID) ?? "biology-midterm",
    userId: trimmed(env.EXPO_PUBLIC_VIVA_USER_ID) ?? "user-1",
    wsBearerToken: trimmed(env.EXPO_PUBLIC_VIVA_WS_BEARER_TOKEN),
    wsOrigin: trimmed(env.EXPO_PUBLIC_VIVA_WS_ORIGIN),
  };
}
