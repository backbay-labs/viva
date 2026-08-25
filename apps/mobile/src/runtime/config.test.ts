import { describe, expect, test } from "bun:test";
import { loadAppConfig, runtimeExpoPublicEnv } from "@/runtime/config";
import { installRuntimeGlobals } from "@/runtime/globals";

describe("loadAppConfig", () => {
  test("reads Expo public runtime defaults through the static bundle seam", () => {
    const previousWsUrl = process.env.EXPO_PUBLIC_VIVA_AGENT_WS_URL;
    const previousUserId = process.env.EXPO_PUBLIC_VIVA_USER_ID;
    try {
      process.env.EXPO_PUBLIC_VIVA_AGENT_WS_URL = "wss://mobile.example/ws";
      process.env.EXPO_PUBLIC_VIVA_USER_ID = "runtime-user";
      const env = runtimeExpoPublicEnv();
      expect(env.EXPO_PUBLIC_VIVA_AGENT_WS_URL).toBe("wss://mobile.example/ws");
      expect(env.EXPO_PUBLIC_VIVA_USER_ID).toBe("runtime-user");
      expect(loadAppConfig().agentHttpUrl).toBe("https://mobile.example");
    } finally {
      if (previousWsUrl === undefined) delete process.env.EXPO_PUBLIC_VIVA_AGENT_WS_URL;
      else process.env.EXPO_PUBLIC_VIVA_AGENT_WS_URL = previousWsUrl;
      if (previousUserId === undefined) delete process.env.EXPO_PUBLIC_VIVA_USER_ID;
      else process.env.EXPO_PUBLIC_VIVA_USER_ID = previousUserId;
    }
  });

  test("defaults to loopback dev agent and fixture identity", () => {
    const config = loadAppConfig({});
    expect(config.agentWsUrl).toBe("ws://127.0.0.1:4318/ws");
    expect(config.agentHttpUrl).toBe("http://127.0.0.1:4318");
    expect(config.restBearerToken).toBe(null);
    expect(config.wsBearerToken).toBe(null);
    expect(config.userId).toBe("user-1");
    expect(config.studySetId).toBe("biology-midterm");
    expect(config.sessionToken).toBe(null);
    expect(config.wsOrigin).toBe(null);
  });

  test("derives http base by stripping /ws and honors wss", () => {
    const config = loadAppConfig({
      EXPO_PUBLIC_VIVA_AGENT_WS_URL: "wss://agent.example.com/ws",
    });
    expect(config.agentHttpUrl).toBe("https://agent.example.com");
  });

  test("explicit http url and identity win", () => {
    const config = loadAppConfig({
      EXPO_PUBLIC_VIVA_AGENT_HTTP_URL: "http://10.0.0.5:4318/",
      EXPO_PUBLIC_VIVA_STUDY_SET_ID: "chem-final",
      EXPO_PUBLIC_VIVA_USER_ID: "user-2",
    });
    expect(config.agentHttpUrl).toBe("http://10.0.0.5:4318");
    expect(config.userId).toBe("user-2");
    expect(config.studySetId).toBe("chem-final");
  });

  test("keeps REST, WebSocket, and first-frame credentials independent", () => {
    const config = loadAppConfig({
      EXPO_PUBLIC_VIVA_REST_BEARER_TOKEN: "rest-static",
      EXPO_PUBLIC_VIVA_SESSION_TOKEN: "signed-first-frame",
      EXPO_PUBLIC_VIVA_WS_BEARER_TOKEN: "ws-static",
    });

    expect(config.restBearerToken).toBe("rest-static");
    expect(config.wsBearerToken).toBe("ws-static");
    expect(config.sessionToken).toBe("signed-first-frame");
  });
});

describe("installRuntimeGlobals", () => {
  test("round-trips binary-safe strings through base64 globals", () => {
    installRuntimeGlobals();
    const value = "viva\u0001ÿ";

    expect(globalThis.atob(globalThis.btoa(value))).toBe(value);
  });

  test("installs missing base64 globals before round-tripping", () => {
    const globals = globalThis as {
      atob?: (data: string) => string;
      btoa?: (data: string) => string;
    };
    const originalAtob = globals.atob;
    const originalBtoa = globals.btoa;

    try {
      globals.atob = undefined;
      globals.btoa = undefined;
      installRuntimeGlobals();

      const installedAtob = globals.atob as ((data: string) => string) | undefined;
      const installedBtoa = globals.btoa as ((data: string) => string) | undefined;
      expect(typeof installedAtob).toBe("function");
      expect(typeof installedBtoa).toBe("function");
      if (typeof installedAtob !== "function" || typeof installedBtoa !== "function") {
        throw new Error("runtime globals were not installed");
      }

      const value = "viva\u0001ÿ";
      expect(installedAtob(installedBtoa(value))).toBe(value);
    } finally {
      globals.atob = originalAtob;
      globals.btoa = originalBtoa;
    }
  });
});
