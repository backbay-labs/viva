import { describe, expect, test } from "bun:test";
import { type AgentSessionConfig, parseVivaClientFrame, parseVivaServerFrame } from "@viva/core";
import fakeSessionFixture from "../../../agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json";
import readyFixture from "../../../agent/fixtures/voice-protocol/server-ready.json";
import sessionFixture from "../../../agent/fixtures/voice-protocol/session-config.json";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/synthetic-study-session.json";
import {
  agentProtocolVersion,
  createVivaAgentSessionController,
  initialVivaAgentSessionState,
  parseVivaAgentMessage,
  vivaAgentProtocols,
  vivaAgentReducer,
  vivaAgentWsUrl,
  vivaApiBaseUrl,
} from "./viva-agent-client";

describe("Viva agent browser client", () => {
  test("uses explicit env URL with local service fallback", () => {
    expect(vivaAgentWsUrl({ NEXT_PUBLIC_VIVA_AGENT_WS_URL: "ws://localhost:4318/ws" })).toBe(
      "ws://localhost:4318/ws",
    );
    expect(vivaAgentWsUrl({})).toBe("ws://127.0.0.1:4318/ws");
    expect(vivaApiBaseUrl({ NEXT_PUBLIC_VIVA_API_URL: "http://localhost:4318/" })).toBe(
      "http://localhost:4318",
    );
    expect(vivaApiBaseUrl({ NEXT_PUBLIC_VIVA_AGENT_WS_URL: "wss://viva.example/ws" })).toBe(
      "https://viva.example",
    );
  });

  test("encodes optional bearer token as websocket subprotocol", () => {
    expect(vivaAgentProtocols()).toEqual(["viva-voice"]);
    expect(vivaAgentProtocols("secret")).toEqual(["viva-voice", "bearer.c2VjcmV0"]);
  });

  test("parses ready frames through core contract", () => {
    const frame = parseVivaAgentMessage(JSON.stringify(readyFixture));

    expect(frame.type).toBe("ready");
    expect(agentProtocolVersion()).toBe(1);
  });

  test("controller sends initial session config and command frames", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: "signed-session-token",
      url: "ws://localhost:4318/ws",
      token: "secret",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    expect(socket.url).toBe("ws://localhost:4318/ws");
    expect(socket.protocols).toEqual(["viva-voice", "bearer.c2VjcmV0"]);

    socket.open();
    const sessionConfig = parseVivaClientFrame(JSON.parse(socket.sent[0] ?? "{}"));
    expect(sessionConfig.type).toBe("session_config");
    if (sessionConfig.type !== "session_config") throw new Error("Expected session config");
    expect(sessionConfig.session_token).toBe("signed-session-token");
    expect("session_token" in sessionConfig.session).toBe(false);

    socket.message(JSON.stringify(readyFixture));
    expect(controller.getState().status).toBe("open");

    controller.sendText("quiz me");
    controller.sendAudio("AQIDBA==");
    controller.cancel();
    controller.stop();
    expect(parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}")).type).toBe("text");
    expect(parseVivaClientFrame(JSON.parse(socket.sent[2] ?? "{}")).type).toBe("audio");
    expect(parseVivaClientFrame(JSON.parse(socket.sent[3] ?? "{}")).type).toBe("cancel");
    expect(parseVivaClientFrame(JSON.parse(socket.sent[4] ?? "{}")).type).toBe("stop");
  });

  test("controller clears stale connected state on reconnect", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      initialState: {
        ...initialVivaAgentSessionState(),
        status: "closed",
        question: {
          question_id: "old-question",
          prompt: "Old prompt",
          expected_terms: [],
          follow_up: "old",
          source: {
            confidence: "high",
            document_id: "lec-5",
            excerpt: "old",
            retrieval_reason: "old",
            source_id: "src-lecture-5-slide-18",
            span: "slide:18",
          },
        },
        recap: {
          voice_session_id: "voice-session-1",
          headline: "Old recap",
          summary: "Old summary",
          strong_concepts: ["old"],
          shaky_concepts: [],
          missed_concepts: [],
          review_later: [],
          next_action: "old",
          source_moments: [],
        },
        transcript: "old transcript",
      },
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    controller.connect();

    expect(controller.getState().status).toBe("connecting");
    expect(controller.getState().question).toBeUndefined();
    expect(controller.getState().recap).toBeUndefined();
    expect(controller.getState().transcript).toBe("");
  });

  test("controller preserves terminal recap when the server closes after stop", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));
    for (const frame of fullSessionFixture.server) {
      socket.message(JSON.stringify(frame));
    }
    expect(controller.getState().recap?.voice_session_id).toBe("voice-session-1");

    socket.close();

    expect(controller.getState().status).toBe("closed");
    expect(controller.getState().recap?.voice_session_id).toBe("voice-session-1");
    expect(controller.getState().phase).toBe("recap");
  });

  test("reducer maps product session fixture and suppresses stale response events", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    expect(state.question?.question_id).toBe("q-oxidative-phosphorylation-nadh");
    expect(state.evaluation?.concept_status).toBe("strong");
    expect(state.sources[0]?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.conceptStatuses["oxidative-phosphorylation"]).toBe("strong");
    expect(state.recap?.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");
    expect(state.cancelledResponseIds).toContain("response-2");

    const stale = parseVivaServerFrame({
      type: "event",
      version: 1,
      event: {
        type: "transcript_delta",
        response_id: "stale-response",
        text: "bad stale text",
      },
    });
    const afterStale = vivaAgentReducer(state, stale);
    expect(afterStale.transcript).not.toContain("bad stale text");
    expect(afterStale.staleEvents).toBe(state.staleEvents + 1);
  });

  test("reducer stores manuscript intents and suppresses stale intent events", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    expect(state.activeResponseId).toBe("response-1");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: { type: "scene_intent", register: "examining", emphasis: "measured" },
        },
      }),
    );
    expect(state.manuscriptIntents).toEqual([
      {
        responseId: "response-1",
        intent: { type: "scene_intent", register: "examining", emphasis: "measured" },
      },
    ]);

    const afterStale = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: {
          type: "manuscript_intent",
          response_id: "stale-response",
          intent: { type: "scene_intent", register: "correcting", emphasis: "marked" },
        },
      }),
    );

    expect(afterStale.manuscriptIntents).toEqual(state.manuscriptIntents);
    expect(afterStale.staleEvents).toBe(state.staleEvents + 1);
  });

  test("reducer maps fake Cartesia/Gemini audio fixture", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fakeSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    expect(state.audio[0]).toEqual({
      responseId: "response-1",
      frame: { pcm16_base64: "AQIDBA==" },
    });
    expect(state.finalTranscript).toBe("received 4 PCM16 bytes");
    expect(state.evaluation?.answer_text).toBe("received 4 PCM16 bytes");
    expect(state.sources[0]?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.recap?.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");
    expect(state.cancelledResponseIds).toContain("response-2");
    expect(state.staleEvents).toBe(0);
  });

  test("reducer suppresses events for a cancelled active response", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    expect(state.activeResponseId).toBe("response-1");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );
    const afterCancelledDelta = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: {
          type: "transcript_delta",
          response_id: "response-1",
          text: "should not land",
        },
      }),
    );

    expect(afterCancelledDelta.transcript).toBe("");
    expect(afterCancelledDelta.staleEvents).toBe(state.staleEvents + 1);
  });

  test("reducer suppresses manuscript intents for a cancelled active response", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );

    const afterCancelledIntent = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: { type: "scene_intent", register: "correcting", emphasis: "marked" },
        },
      }),
    );

    expect(afterCancelledIntent.manuscriptIntents).toEqual([]);
    expect(afterCancelledIntent.staleEvents).toBe(state.staleEvents + 1);
  });

  test("reducer accepts a replacement turn after active response cancellation", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fakeSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    expect(state.activeResponseId).toBe("response-1");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: 1,
        event: {
          type: "transcript_final",
          response_id: "response-2",
          text: "replacement answer",
          confidence: 0.9,
        },
      }),
    );

    expect(state.finalTranscript).toBe("replacement answer");
    expect(state.staleEvents).toBe(0);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: Event & { data?: unknown }) => void>>();

  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event & { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open() {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  message(data: string) {
    this.emit("message", Object.assign(new Event("message"), { data }));
  }

  private emit(type: string, event: Event & { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
