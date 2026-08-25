import { describe, expect, test } from "bun:test";
import type { AgentSessionConfig } from "@viva/core";
import {
  applyMobileAppStateChange,
  createGuardedWebSocketImplementation,
  createMobileSessionController,
  foregroundReconnectAction,
} from "@/agent/use-mobile-viva-session";
import type { AppConfig } from "@/runtime/config";

type Listener = (event: Event & { data?: unknown }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: unknown[] = [];
  readyState = 0;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  private emit(type: string, event: Event & { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const config: AppConfig = {
  agentHttpUrl: "http://127.0.0.1:4318",
  agentWsUrl: "ws://127.0.0.1:4318/ws",
  sessionToken: null,
  studySetId: "biology-midterm",
  userId: "user-1",
  wsOrigin: "https://mobile.viva.example",
};

const session: AgentSessionConfig = {
  active_concepts: ["nadh"],
  initial_goal: "Recall NADH",
  mode: "quiz",
  session_id: "session-1",
  source_context: [],
  study_set_id: "biology-midterm",
  user_id: "user-1",
};

describe("createMobileSessionController", () => {
  test("connects with origin, sends only the typed protocol, and omits sendAudio", () => {
    FakeWebSocket.instances = [];
    const controller = createMobileSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      config,
      session,
    });

    controller.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe(config.agentWsUrl);
    expect(socket?.protocols).toEqual(["viva-voice"]);
    expect(socket?.options).toEqual({ headers: { Origin: config.wsOrigin } });
    expect(controller.sendText("too early")).toBe(false);
    expect(controller.getState().errors).toContain("WebSocket is not open");

    socket?.open();
    expect(controller.sendText("NADH donates electrons")).toBe(true);
    controller.cancel();
    controller.stop();

    const frames = socket?.sent.map((value) => JSON.parse(String(value))) ?? [];
    expect(frames.map((frame) => frame.type)).toEqual(["session_config", "text", "cancel", "stop"]);
    expect(frames[0]?.session).toEqual(session);
    expect("sendAudio" in controller).toBe(false);
  });

  test("rejects binary, malformed, audio, and unknown outbound frames", () => {
    FakeWebSocket.instances = [];
    const GuardedWebSocket = createGuardedWebSocketImplementation(
      FakeWebSocket as unknown as typeof WebSocket,
      null,
    );
    const socket = new GuardedWebSocket("ws://127.0.0.1:4318/ws", ["viva-voice"]);

    for (const payload of [
      new Uint8Array([1, 2, 3]),
      "not-json",
      JSON.stringify({ type: "audio", version: 4, audio: "AQID" }),
      JSON.stringify({ type: "bogus", version: 4 }),
    ]) {
      expect(() => (socket.send as (value: unknown) => void)(payload)).toThrow();
    }
    expect(FakeWebSocket.instances[0]?.sent).toHaveLength(0);
  });
});

describe("foregroundReconnectAction", () => {
  test("reconnects only unfinished inactive sessions", () => {
    expect(foregroundReconnectAction({ hasRecap: true, status: "closed" })).toBe("none");
    expect(foregroundReconnectAction({ hasRecap: false, status: "closed" })).toBe("reconnect");
    expect(foregroundReconnectAction({ hasRecap: false, status: "error" })).toBe("reconnect");
    expect(foregroundReconnectAction({ hasRecap: false, status: "open" })).toBe("none");
    expect(foregroundReconnectAction({ hasRecap: false, status: "connecting" })).toBe("none");
  });

  test("background and retry clear local audio without producing audio or binary frames", () => {
    FakeWebSocket.instances = [];
    const controller = createMobileSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      config,
      session,
    });
    controller.connect();
    FakeWebSocket.instances[0]?.open();
    expect(controller.sendText("typed answer")).toBe(true);

    const captureCalls = { cancel: 0, reset: 0 };
    const playbackCalls = { reset: 0 };
    const capture = {
      cancel: async () => {
        captureCalls.cancel += 1;
      },
      reset: async () => {
        captureCalls.reset += 1;
      },
    };
    const playback = {
      resetForGeneration: () => {
        playbackCalls.reset += 1;
      },
    };

    expect(
      applyMobileAppStateChange({
        capture,
        controller,
        hasRecap: false,
        nextState: "background",
        playback,
        status: "open",
      }),
    ).toBe("backgrounded");
    expect(captureCalls).toEqual({ cancel: 1, reset: 0 });

    expect(
      applyMobileAppStateChange({
        capture,
        controller,
        hasRecap: false,
        nextState: "active",
        playback,
        status: "closed",
      }),
    ).toBe("reconnected");
    FakeWebSocket.instances[1]?.open();
    expect(captureCalls).toEqual({ cancel: 1, reset: 1 });
    expect(playbackCalls.reset).toBe(2);

    const sent = FakeWebSocket.instances.flatMap((socket) => socket.sent);
    expect(sent.every((value) => typeof value === "string")).toBe(true);
    expect(
      sent.every((value) =>
        ["session_config", "text", "cancel", "stop"].includes(JSON.parse(String(value)).type),
      ),
    ).toBe(true);
    expect(sent.some((value) => JSON.parse(String(value)).type === "audio")).toBe(false);
  });
});
