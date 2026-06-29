import { describe, expect, test } from "bun:test";
import {
  type AgentSessionConfig,
  type AgentStudySourceReference,
  parseVivaClientFrame,
  parseVivaServerFrame,
  VIVA_VOICE_PROTOCOL_VERSION,
} from "@viva/core";
import fakeSessionFixture from "../../../agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json";
import readyFixture from "../../../agent/fixtures/voice-protocol/server-ready.json";
import sessionFixture from "../../../agent/fixtures/voice-protocol/session-config.json";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/synthetic-study-session.json";
import {
  agentProtocolVersion,
  createVivaAgentSessionController,
  deleteVivaSessionHistory,
  deleteVivaStudySet,
  exportVivaLibraryData,
  fetchVivaAgentReadinessProbe,
  fetchVivaLibrarySnapshot,
  initialVivaAgentSessionState,
  parseVivaAgentMessage,
  refreshVivaSessionToken,
  vivaAgentHttpBaseUrl,
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
    expect(vivaApiBaseUrl({})).toBeUndefined();
    expect(vivaApiBaseUrl({ NEXT_PUBLIC_VIVA_AGENT_WS_URL: "ws://localhost:5199/ws" })).toBe(
      "http://localhost:5199",
    );
    expect(vivaApiBaseUrl({ NEXT_PUBLIC_VIVA_API_URL: "http://localhost:4318/" })).toBe(
      "http://localhost:4318",
    );
    expect(vivaApiBaseUrl({ NEXT_PUBLIC_VIVA_AGENT_WS_URL: "wss://viva.example/ws" })).toBe(
      "https://viva.example",
    );
    expect(vivaAgentHttpBaseUrl({})).toBe("http://127.0.0.1:4318");
    expect(vivaAgentHttpBaseUrl({ NEXT_PUBLIC_VIVA_AGENT_WS_URL: "wss://viva.example/ws" })).toBe(
      "https://viva.example",
    );
    expect(
      vivaAgentHttpBaseUrl({
        NEXT_PUBLIC_VIVA_AGENT_WS_URL: "ws://localhost:5199/ws",
        NEXT_PUBLIC_VIVA_API_URL: "http://localhost:3000/",
      }),
    ).toBe("http://localhost:5199");
    expect(
      vivaAgentHttpBaseUrl({
        NEXT_PUBLIC_VIVA_AGENT_HTTP_URL: "http://agent.local:4318/",
        NEXT_PUBLIC_VIVA_API_URL: "http://localhost:3000/",
      }),
    ).toBe("http://agent.local:4318");
    expect(
      vivaAgentHttpBaseUrl({
        NEXT_PUBLIC_VIVA_AGENT_WS_URL: "not-a-url",
        NEXT_PUBLIC_VIVA_API_URL: "http://localhost:3000/",
      }),
    ).toBeUndefined();
    expect(vivaAgentHttpBaseUrl({ NEXT_PUBLIC_VIVA_API_URL: "http://localhost:3000/" })).toBe(
      "http://127.0.0.1:4318",
    );
  });

  test("fetches /health/brain and /ready without treating gated 503 as offline", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health/brain")) {
        return jsonResponse(200, {
          provider: "cartesia_gemini",
          brain: {
            provider: "cartesia_gemini",
            configured: true,
            selectable: false,
            live_runtime: false,
          },
          store: readyFixture.store,
          status: "unavailable",
        });
      }
      if (url.endsWith("/ready")) {
        return jsonResponse(503, {
          ready: false,
          brain: {
            provider: "cartesia_gemini",
            configured: true,
            selectable: false,
            live_runtime: false,
          },
          store: readyFixture.store,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const probe = await fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(calls).toEqual(["http://localhost:4318/health/brain", "http://localhost:4318/ready"]);
    expect(probe.status).toBe("observed");
    if (probe.status !== "observed") throw new Error("Expected observed probe");
    expect(probe.readyHttpStatus).toBe(503);
    expect(probe.ready.ready).toBe(false);
    expect(probe.health.brain.provider).toBe("cartesia_gemini");
    expect(probe.health.brain.selectable).toBe(false);
  });

  test("reports readiness endpoints as offline when fetch fails", async () => {
    const probe = await fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(probe.status).toBe("offline");
    if (probe.status !== "offline") throw new Error("Expected offline probe");
    expect(probe.error).toContain("connection refused");
  });

  test("reports readiness endpoints as offline when JSON contracts are invalid", async () => {
    const probe = await fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health/brain")) return jsonResponse(200, { error: "not found" });
        if (url.endsWith("/ready")) return jsonResponse(200, { ready: true });
        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(probe.status).toBe("offline");
    if (probe.status !== "offline") throw new Error("Expected offline probe");
    expect(probe.error).toContain("invalid /health/brain readiness payload");
  });

  test("reports /ready as offline when store nonce replay capability is missing", async () => {
    const { nonce_replay_protection: _nonce, ...storeWithoutNonce } = readyFixture.store;
    const probe = await fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health/brain")) {
          return jsonResponse(200, {
            provider: "cartesia_gemini",
            brain: {
              provider: "cartesia_gemini",
              configured: true,
              selectable: true,
              live_runtime: false,
            },
            store: readyFixture.store,
            status: "ok",
          });
        }
        if (url.endsWith("/ready")) {
          return jsonResponse(200, {
            ready: true,
            brain: {
              provider: "cartesia_gemini",
              configured: true,
              selectable: true,
              live_runtime: false,
            },
            store: storeWithoutNonce,
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(probe.status).toBe("offline");
    if (probe.status !== "offline") throw new Error("Expected offline probe");
    expect(probe.error).toContain("invalid /ready readiness payload");
  });

  test("encodes optional bearer token as websocket subprotocol", () => {
    expect(vivaAgentProtocols()).toEqual(["viva-voice"]);
    expect(vivaAgentProtocols("secret")).toEqual(["viva-voice", "bearer.c2VjcmV0"]);
  });

  test("parses ready frames through core contract", () => {
    const frame = parseVivaAgentMessage(JSON.stringify(readyFixture));

    expect(frame.type).toBe("ready");
    expect(agentProtocolVersion()).toBe(VIVA_VOICE_PROTOCOL_VERSION);
  });

  test("refreshes signed session material through the same-origin browser route", async () => {
    const calls: Array<{ body: unknown; url: string }> = [];
    const result = await refreshVivaSessionToken(
      {
        sessionId: "session-1",
        sessionToken: "placeholder-current-material",
        studySetId: "study-set-1",
        userId: "user-1",
      },
      {
        apiBaseUrl: "http://localhost:3000",
        fetchImpl: async (input, init) => {
          calls.push({
            body: JSON.parse(String(init?.body ?? "{}")),
            url: String(input),
          });
          return jsonResponse(200, {
            failure_class: null,
            session: {
              session_id: "session-1",
              study_set_id: "study-set-1",
              user_id: "user-1",
            },
            session_token: "placeholder-refreshed-material",
            token_refresh_outcome: "refreshed",
          });
        },
      },
    );

    expect(calls).toEqual([
      {
        body: {
          session_id: "session-1",
          session_token: "placeholder-current-material",
          study_set_id: "study-set-1",
          user_id: "user-1",
        },
        url: "http://localhost:3000/api/viva-session/refresh",
      },
    ]);
    expect(result.session_token).toBe("placeholder-refreshed-material");
  });

  test("controller sends initial session config and command frames", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
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
    expect(sessionConfig.client_generation_id).toBe("session_bootstrap-1");
    expect(sessionConfig.session_token).toBe("signed-session-token");
    expect("session_token" in sessionConfig.session).toBe(false);

    socket.message(JSON.stringify(readyFixture));
    expect(controller.getState().status).toBe("open");

    controller.sendText("quiz me");
    socket.message(
      JSON.stringify({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "feedback" },
      }),
    );
    controller.sendAudio("AQIDBA==");
    controller.cancel();
    controller.stop();
    expect(parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}"))).toEqual({
      client_generation_id: "session_bootstrap-1",
      text: "quiz me",
      type: "text",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
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

  test("acknowledgeAudio drops exactly the consumed frames by identity so the buffer stays bounded", () => {
    const audio = [
      { responseId: "r1", frame: {} },
      { responseId: "r1", frame: {} },
      { responseId: "r2", frame: {} },
    ] as unknown as ReturnType<typeof initialVivaAgentSessionState>["audio"];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      initialState: { ...initialVivaAgentSessionState(), audio },
    });

    controller.acknowledgeAudio([audio[0], audio[1]]);
    expect(controller.getState().audio).toEqual([audio[2]]);
    // No-op guards: empty consumed / empty state never mutate.
    controller.acknowledgeAudio([]);
    expect(controller.getState().audio).toHaveLength(1);
    controller.acknowledgeAudio([audio[2]]);
    expect(controller.getState().audio).toHaveLength(0);
  });

  test("acknowledgeAudio spares the next response when a stale ack races a cancellation", () => {
    // The consumer's snapshot was [r1a, r1b]; meanwhile r2a arrived and a
    // cancellation(r1) filtered r1's frames out, leaving live state = [r2a]. A
    // positional slice(2) would wrongly clear r2a; an identity filter spares it.
    const r1a = { responseId: "r1", frame: {} };
    const r1b = { responseId: "r1", frame: {} };
    const r2a = { responseId: "r2", frame: {} };
    const liveAudio = [r2a] as unknown as ReturnType<typeof initialVivaAgentSessionState>["audio"];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      initialState: { ...initialVivaAgentSessionState(), audio: liveAudio },
    });

    controller.acknowledgeAudio([r1a, r1b] as unknown as ReturnType<
      typeof initialVivaAgentSessionState
    >["audio"]);

    expect(controller.getState().audio).toEqual([r2a]);
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

  test("reducer treats recap_ready as terminal without a trailing session_phase", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 18).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    expect(state.recap?.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");

    const stalePhase = parseVivaServerFrame({
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: { type: "session_phase", phase: "correction" },
    });
    const afterStalePhase = vivaAgentReducer(state, stalePhase);

    expect(afterStalePhase.phase).toBe("recap");
    expect(afterStalePhase.recap?.voice_session_id).toBe("voice-session-1");
  });

  test("reducer suppresses stale recap_ready for a superseded response", () => {
    const state = {
      ...initialVivaAgentSessionState(),
      activeResponseId: "response-b",
      phase: "thinking" as const,
      pendingSubmission: { generationId: "response-b-generation", kind: "audio" as const },
    };
    const afterStaleRecap = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "recap_ready",
          response_id: "response-a",
          recap: {
            voice_session_id: "voice-session-1",
            headline: "Stale recap",
            summary: "Old answer recap",
            strong_concepts: [],
            shaky_concepts: [],
            missed_concepts: [],
            review_later: [],
            next_action: "Keep working on the current answer.",
            source_moments: [],
          },
        },
      }),
    );

    expect(afterStaleRecap.recap).toBeUndefined();
    expect(afterStaleRecap.phase).toBe("thinking");
    expect(afterStaleRecap.activeResponseId).toBe("response-b");
    expect(afterStaleRecap.staleEvents).toBe(state.staleEvents + 1);
  });

  test("reducer accepts a pending second attempt when response id carries the submission generation", () => {
    const state = {
      ...initialVivaAgentSessionState(),
      activeResponseId: "response-1",
      phase: "thinking" as const,
      pendingSubmission: { generationId: "session_bootstrap-1", kind: "audio" as const },
    };
    const next = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "transcript_final",
          response_id: "response-2-generation-session_bootstrap-1",
          text: "second attempt answer",
          confidence: null,
        },
      }),
    );

    expect(next.activeResponseId).toBe("response-2-generation-session_bootstrap-1");
    expect(next.finalTranscript).toBe("second attempt answer");
    expect(next.transcriptConfidence).toBeUndefined();
    expect(next.staleEvents).toBe(0);
  });

  test("reducer still rejects nonmatching response ids while a submission is pending", () => {
    const state = {
      ...initialVivaAgentSessionState(),
      activeResponseId: "response-1",
      phase: "thinking" as const,
      pendingSubmission: { generationId: "session_bootstrap-1", kind: "audio" as const },
    };
    const next = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "transcript_final",
          response_id: "response-2-generation-other",
          text: "wrong pending answer",
          confidence: 0.95,
        },
      }),
    );

    expect(next.activeResponseId).toBe("response-1");
    expect(next.finalTranscript).toBeUndefined();
    expect(next.staleEvents).toBe(1);
  });

  test("reducer does not match pending generation id prefixes", () => {
    const state = {
      ...initialVivaAgentSessionState(),
      activeResponseId: "response-1",
      phase: "thinking" as const,
      pendingSubmission: { generationId: "session_bootstrap-1", kind: "audio" as const },
    };
    const next = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "transcript_final",
          response_id: "response-2-generation-session_bootstrap-10",
          text: "wrong pending answer",
          confidence: 0.95,
        },
      }),
    );

    expect(next.activeResponseId).toBe("response-1");
    expect(next.finalTranscript).toBeUndefined();
    expect(next.staleEvents).toBe(1);
  });

  const sourceFixture = (sourceId: string, excerpt: string): AgentStudySourceReference => ({
    source_id: sourceId,
    document_id: "lec-5",
    span: "slide:18",
    excerpt,
    confidence: "high",
    retrieval_reason: "bounded source moment",
  });

  test("cancelling the active turn discards its examiner-response artifacts (no folio bleed)", () => {
    const src = sourceFixture("src-1", "NADH donates electrons to the electron transport chain.");
    const withSource = vivaAgentReducer(
      { ...initialVivaAgentSessionState(), activeResponseId: "resp-1" },
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "source_reference", response_id: "resp-1", source: src },
      }),
    );
    expect(withSource.currentSource?.source_id).toBe("src-1");
    expect(withSource.sources).toHaveLength(1);

    // The cancelled turn also carries a verdict + concept status. Its source would
    // otherwise re-surface via the folio's currentSource -> evaluation.source
    // fallback, so the cancel must discard the whole examiner-response set.
    const afterCancel = vivaAgentReducer(
      { ...withSource, currentConceptStatus: "shaky", evaluation: { source: src } as never },
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "resp-1" },
      }),
    );

    expect(afterCancel.currentSource).toBeUndefined();
    expect(afterCancel.sources).toEqual([]);
    expect(afterCancel.evaluation).toBeUndefined();
    expect(afterCancel.currentConceptStatus).toBeUndefined();
    expect(afterCancel.activeResponseId).toBeUndefined();
  });

  test("cancelling a stale (non-active) response leaves the active turn's source intact", () => {
    const active = sourceFixture("src-active", "Active turn excerpt.");
    const afterCancel = vivaAgentReducer(
      {
        ...initialVivaAgentSessionState(),
        activeResponseId: "resp-2",
        currentSource: active,
        sources: [active],
      },
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "resp-1" },
      }),
    );

    expect(afterCancel.currentSource?.source_id).toBe("src-active");
    expect(afterCancel.sources).toHaveLength(1);
    expect(afterCancel.activeResponseId).toBe("resp-2");
  });

  test("reducer keeps the transcript_final confidence and resets it on the next question", () => {
    const withTranscript = vivaAgentReducer(
      { ...initialVivaAgentSessionState(), activeResponseId: "resp-1" },
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "transcript_final",
          response_id: "resp-1",
          text: "NADH donates electrons",
          confidence: 0.42,
        },
      }),
    );
    expect(withTranscript.finalTranscript).toBe("NADH donates electrons");
    expect(withTranscript.transcriptConfidence).toBe(0.42);

    const nextQuestion = vivaAgentReducer(
      withTranscript,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "question_started",
          response_id: "resp-2",
          question: {
            question_id: "q2",
            prompt: "Next question.",
            expected_terms: [],
            follow_up: "x",
            source: {
              source_id: "s2",
              document_id: "lec-6",
              span: "slide:4",
              excerpt: "next excerpt",
              confidence: "high",
              retrieval_reason: "next",
            },
          },
        },
      }),
    );
    expect(nextQuestion.transcriptConfidence).toBeUndefined();
  });

  test("reducer records controlled terminal phase reasons as authoritative recap state without inventing a recap", () => {
    const state = vivaAgentReducer(
      initialVivaAgentSessionState(),
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "session_phase",
          phase: "recap",
          terminal_reason: "drained",
        },
      }),
    );

    expect(state.phase).toBe("recap");
    expect(state.recap).toBeUndefined();
    expect(state.terminalReason).toBe("drained");
  });

  test("reducer sanitizes server error frames before projection can render them", () => {
    const rawProviderMessage =
      "provider prompt transcript with bearer viva1.secret-token and raw answer text";
    const state = vivaAgentReducer(initialVivaAgentSessionState(), {
      type: "error",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      message: rawProviderMessage,
    });

    expect(state.errors).toEqual(["sanitized provider error"]);
    expect(JSON.stringify(state)).not.toContain("viva1.secret-token");
    expect(JSON.stringify(state)).not.toContain("raw answer text");
  });

  test("reducer normalizes legacy auth errors to the coarse recovery reason", () => {
    for (const message of [
      "invalid session token",
      "invalid session identity",
      "study set access denied",
    ]) {
      const state = vivaAgentReducer(initialVivaAgentSessionState(), {
        type: "error",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        message,
      });

      expect(state.errors).toEqual(["session auth failed"]);
    }
  });

  test("reducer sanitizes structured provider errors before projection can render them", () => {
    const rawProviderMessage =
      "structured_error prompt transcript with CARTESIA_API_KEY and source excerpt";
    const state = vivaAgentReducer(initialVivaAgentSessionState(), {
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: {
        type: "structured_error",
        source: "cartesia_gemini",
        message: rawProviderMessage,
      },
    });

    expect(state.errors).toEqual(["sanitized provider error"]);
    expect(JSON.stringify(state)).not.toContain("CARTESIA_API_KEY");
    expect(JSON.stringify(state)).not.toContain("source excerpt");
  });

  test("controller records sanitized close diagnostics when the server closes the socket", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.close({
      code: 1008,
      reason:
        "provider payload rejected bearer viva1.secret-token with raw answer transcript that should be redacted",
      wasClean: false,
    });

    expect(controller.getState().status).toBe("closed");
    expect(controller.getState().close).toEqual({
      code: 1008,
      reason: "[redacted close reason]",
      wasClean: false,
    });
  });

  test("controller only displays allowlisted close reasons", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.close({
      code: 1008,
      reason: "NADH donates electrons before the exam answer key is shown",
      wasClean: false,
    });

    expect(controller.getState().close).toEqual({
      code: 1008,
      reason: "[redacted close reason]",
      wasClean: false,
    });
  });

  test("controller preserves standardized auth close reasons for recovery classification", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.close({
      code: 1008,
      reason: "session auth failed",
      wasClean: false,
    });

    expect(controller.getState().close).toEqual({
      code: 1008,
      reason: "session auth failed",
      wasClean: false,
    });
  });

  test("controller normalizes legacy auth close reasons before projection", () => {
    for (const reason of [
      "invalid session token",
      "invalid session identity",
      "study set access denied",
    ]) {
      FakeWebSocket.instances = [];
      const controller = createVivaAgentSessionController({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        session: sessionFixture as AgentSessionConfig,
        url: "ws://localhost:4318/ws",
      });

      const socket = controller.connect() as unknown as FakeWebSocket;
      socket.open();
      socket.close({
        code: 1008,
        reason,
        wasClean: false,
      });

      expect(controller.getState().close).toEqual({
        code: 1008,
        reason: "session auth failed",
        wasClean: false,
      });
    }
  });

  test("controller reconnect closes the previous socket before opening a replacement", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const first = controller.connect() as unknown as FakeWebSocket;
    expect(controller.getState().generation).toEqual({
      id: "session_bootstrap-1",
      reason: "session_bootstrap",
      sequence: 1,
    });
    const second = controller.connect("socket_retry") as unknown as FakeWebSocket;

    expect(FakeWebSocket.instances).toEqual([first, second]);
    expect(first.closeCount).toBe(1);
    expect(first.readyState).toBe(3);
    expect(second.closeCount).toBe(0);
    expect(controller.getState().status).toBe("connecting");
    expect(controller.getState().generation).toEqual({
      id: "socket_retry-2",
      reason: "socket_retry",
      sequence: 2,
    });
  });

  test("controller ignores stale socket events and close frames from prior generations", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const first = controller.connect() as unknown as FakeWebSocket;
    const second = controller.connect("socket_retry") as unknown as FakeWebSocket;

    first.open();
    expect(first.sent).toHaveLength(0);

    second.open();
    second.message(JSON.stringify(readyFixture));
    expect(controller.getState().status).toBe("open");
    expect(controller.getState().generation?.id).toBe("socket_retry-2");
    expect(parseVivaClientFrame(JSON.parse(second.sent[0] ?? "{}")).client_generation_id).toBe(
      "socket_retry-2",
    );

    first.message(
      JSON.stringify({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "recap", terminal_reason: "drained" },
      }),
    );
    first.close({ code: 1000, reason: "client stop", wasClean: true });

    expect(controller.getState().status).toBe("open");
    expect(controller.getState().phase).toBe("ready");
    expect(controller.getState().close).toBeUndefined();
    expect(controller.getState().generation?.id).toBe("socket_retry-2");
  });

  test("controller refresh gets a new generation and stale thinking events cannot overwrite it", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: "placeholder-initial-material",
      url: "ws://localhost:4318/ws",
    });

    const first = controller.connect() as unknown as FakeWebSocket;
    first.open();
    first.message(JSON.stringify(readyFixture));
    first.message(
      JSON.stringify({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "thinking" },
      }),
    );
    expect(controller.getState().phase).toBe("thinking");

    const refreshed = controller.refreshSession({
      sessionToken: "placeholder-refreshed-material",
    }) as unknown as FakeWebSocket;
    expect(refreshed.protocols).toEqual(vivaAgentProtocols("placeholder-refreshed-material"));
    expect(controller.getState().status).toBe("connecting");
    expect(controller.getState().phase).toBe("ready");
    expect(controller.getState().generation?.id).toBe("token_refresh-2");

    first.message(
      JSON.stringify({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "recap", terminal_reason: "drained" },
      }),
    );
    first.close({ code: 1000, reason: "client stop", wasClean: true });

    refreshed.open();
    const refreshConfig = parseVivaClientFrame(JSON.parse(refreshed.sent[0] ?? "{}"));
    expect(refreshConfig.type).toBe("session_config");
    if (refreshConfig.type !== "session_config") throw new Error("Expected session config");
    expect(refreshConfig.client_generation_id).toBe("token_refresh-2");
    expect(refreshConfig.session_token).toBe("placeholder-refreshed-material");
    refreshed.message(JSON.stringify(readyFixture));

    expect(controller.getState().status).toBe("open");
    expect(controller.getState().phase).toBe("ready");
    expect(controller.getState().close).toBeUndefined();
    expect(controller.getState().generation?.id).toBe("token_refresh-2");
  });

  test("controller marks token-backed websocket errors as refreshable preflight failures", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: "placeholder-expired-material",
      token: "placeholder-expired-material",
      url: "ws://localhost:4318/ws",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.error();

    expect(controller.getState().status).toBe("error");
    expect(controller.getState().errors.at(-1)).toBe("WebSocket session token preflight failed");
  });

  test("controller drops duplicate answer submits while a provider turn is pending", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      url: "ws://localhost:4318/ws",
    });

    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));

    expect(controller.sendText("first typed response")).toBe(true);
    expect(controller.sendText("second typed response")).toBe(false);
    expect(controller.sendAudio("AQIDBA==")).toBe(false);

    expect(
      socket.sent.slice(1).map((frame) => parseVivaClientFrame(JSON.parse(frame)).type),
    ).toEqual(["text"]);
    expect(parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}"))).toEqual({
      client_generation_id: "session_bootstrap-1",
      text: "first typed response",
      type: "text",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    expect(controller.getState().pendingSubmission).toEqual({
      generationId: "session_bootstrap-1",
      kind: "text",
    });

    socket.message(
      JSON.stringify({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "listening" },
      }),
    );
    expect(controller.getState().pendingSubmission).toEqual({
      generationId: "session_bootstrap-1",
      kind: "text",
    });
    expect(controller.sendText("still duplicate typed response")).toBe(false);

    socket.message(
      JSON.stringify({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "feedback" },
      }),
    );
    expect(controller.getState().pendingSubmission).toBeUndefined();

    expect(controller.sendText("followup typed response")).toBe(true);
    expect(
      socket.sent.slice(1).map((frame) => parseVivaClientFrame(JSON.parse(frame)).type),
    ).toEqual(["text", "text"]);
  });

  test("reducer keeps pending submissions when stale cancellations arrive", () => {
    const pendingSubmission = {
      generationId: "session_bootstrap-1",
      kind: "text" as const,
    };
    const state = {
      ...initialVivaAgentSessionState(),
      activeResponseId: "response-2",
      pendingSubmission,
      phase: "thinking" as const,
    };

    const next = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );

    expect(next.activeResponseId).toBe("response-2");
    expect(next.phase).toBe("thinking");
    expect(next.pendingSubmission).toEqual(pendingSubmission);
    expect(next.cancelledResponseIds).toContain("response-1");
  });

  test("reducer maps product session fixture and suppresses stale response events", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    expect(state.question?.question_id).toBe("q-oxidative-phosphorylation-nadh");
    expect(state.evaluation?.concept_status).toBe("shaky");
    expect(state.currentSource?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.sources[0]?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.currentConceptStatus).toBe("shaky");
    expect(state.conceptStatuses.nadh).toBe("shaky");
    expect(state.manuscriptIntents.map((event) => event.intent.type)).toEqual([
      "scene_intent",
      "marginalia_intent",
      "entity_intent",
    ]);
    expect(state.recap?.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");
    expect(state.cancelledResponseIds).toContain("response-2");

    const stale = parseVivaServerFrame({
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: {
        type: "transcript_delta",
        response_id: "stale-response",
        text: "bad stale text",
      },
    });
    const afterStale = vivaAgentReducer(state, stale);
    expect(afterStale.transcript).not.toContain("bad stale text");
    expect(afterStale.staleEvents).toBe(state.staleEvents + 1);

    const currentQuestion = state.question;
    if (!currentQuestion) throw new Error("Expected current question");
    const nextQuestion = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "question_started",
          response_id: "response-next",
          question: {
            ...currentQuestion,
            question_id: "q-next",
            prompt: "Next question",
          },
        },
      }),
    );
    expect(nextQuestion.currentSource).toBeUndefined();
    expect(nextQuestion.currentConceptStatus).toBeUndefined();
    expect(nextQuestion.sources).toEqual([]);
    expect(nextQuestion.conceptStatuses.nadh).toBe("shaky");
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
        version: VIVA_VOICE_PROTOCOL_VERSION,
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
        version: VIVA_VOICE_PROTOCOL_VERSION,
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
    expect(state.finalTranscript).toBe("NADH donates electrons to the electron transport chain.");
    expect(JSON.stringify(state.evaluation)).not.toContain("answer_text");
    expect(JSON.stringify(state.evaluation)).not.toContain(
      "NADH donates electrons to the electron transport chain.",
    );
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
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );
    const afterCancelledDelta = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
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

  test("reducer treats global cancellation as cancelling the active response", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    expect(state.activeResponseId).toBe("response-1");
    const source = state.question?.source;
    if (!source) throw new Error("Expected active question source");
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "session_phase", phase: "thinking" },
      }),
    );
    expect(state.phase).toBe("thinking");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: null },
      }),
    );

    expect(state.activeResponseId).toBeUndefined();
    expect(state.phase).toBe("listening");
    expect(state.cancelledResponseIds).toContain("response-1");

    const staleFrames = [
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "answer_evaluated",
          response_id: "response-1",
          evaluation: {
            question_id: "q-oxidative-phosphorylation-nadh",
            label: "mostly correct",
            concise_feedback: "stale feedback",
            retry_prompt: "stale retry",
            source,
            concept_status: "strong",
            confidence_score: 0.84,
          },
        },
      }),
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "source_reference",
          response_id: "response-1",
          source,
        },
      }),
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "recap_ready",
          response_id: "response-1",
          recap: {
            voice_session_id: "voice-session-1",
            headline: "Stale recap",
            summary: "Stale summary",
            strong_concepts: ["NADH"],
            shaky_concepts: [],
            missed_concepts: [],
            review_later: [],
            next_action: "Do not surface stale recap.",
            source_moments: [{ text: "Stale source", source, status: "strong" }],
          },
        },
      }),
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "audio_delta",
          response_id: "response-1",
          frame: { pcm16_base64: "AQIDBA==" },
        },
      }),
    ];

    const beforeStaleCount = state.staleEvents;
    for (const frame of staleFrames) state = vivaAgentReducer(state, frame);

    expect(state.evaluation).toBeUndefined();
    expect(state.currentSource).toBeUndefined();
    expect(state.sources).toEqual([]);
    expect(state.recap).toBeUndefined();
    expect(state.audio).toEqual([]);
    expect(state.staleEvents).toBe(beforeStaleCount + staleFrames.length);
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
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );

    const afterCancelledIntent = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
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
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "response-1" },
      }),
    );
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
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

  test("fetches server-owned library snapshot without rewriting action tokens", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, {
        user_id: "user-1",
        privacy: {
          copy: "Voice recordings and transcripts are not saved; Viva stores sanitized study meaning only.",
          export: { available: true },
          export_contains_raw_provider_payloads: false,
          raw_audio_persistence: false,
          transcript_persistence: false,
          transcripts_saved: false,
          voice_recordings_saved: false,
        },
        study_sets: [
          {
            id: "biology-midterm",
            user_id: "user-1",
            title: "Biology Midterm",
            course: "Biology 201",
            ingestion_status: "ready",
            ingestion_error: null,
            server_owned: true,
            documents: [],
            concept_count: 1,
            question_count: 1,
            actions: {
              start: {
                available: true,
                session_id: "server-session",
                session_token: "viva1.server-token",
              },
              resume: { available: false, unavailable_reason: "no_open_session" },
              archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
              delete: { available: false, unavailable_reason: "server_mutation_unavailable" },
            },
          },
        ],
        sessions: [],
      });
    }) as typeof fetch;

    const snapshot = await fetchVivaLibrarySnapshot({
      apiBaseUrl: "http://127.0.0.1:4318/",
      fetchImpl,
      userId: "user-1",
    });

    expect(calls[0]?.input).toBe("http://127.0.0.1:4318/study-sets/library?user_id=user-1");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(snapshot.study_sets[0]?.actions.start).toEqual({
      available: true,
      session_id: "server-session",
      session_token: "viva1.server-token",
    });
    expect(snapshot.privacy.voice_recordings_saved).toBe(false);
  });

  test("uses an absolute same-origin proxy URL for browser library calls", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalEnv = process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL;
    const originalApiEnv = process.env.NEXT_PUBLIC_VIVA_API_URL;
    const originalStaticExport = process.env.NEXT_PUBLIC_VIVA_STATIC_EXPORT;
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, {
        privacy: {
          copy: "Voice recordings and transcripts are not saved.",
          export: { available: false, unavailable_reason: "mutation_auth_required" },
          export_contains_raw_provider_payloads: false,
          raw_audio_persistence: false,
          transcript_persistence: false,
          transcripts_saved: false,
          voice_recordings_saved: false,
        },
        sessions: [],
        study_sets: [],
        user_id: "user-1",
      });
    }) as typeof fetch;

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { origin: "http://localhost:3000" } },
      });
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.example";
      process.env.NEXT_PUBLIC_VIVA_API_URL = "https://agent.example";
      delete process.env.NEXT_PUBLIC_VIVA_STATIC_EXPORT;

      await fetchVivaLibrarySnapshot({ fetchImpl, userId: "user-1" });
    } finally {
      restoreGlobalProperty("window", originalWindow);
      restoreEnv("NEXT_PUBLIC_VIVA_AGENT_HTTP_URL", originalEnv);
      restoreEnv("NEXT_PUBLIC_VIVA_API_URL", originalApiEnv);
      restoreEnv("NEXT_PUBLIC_VIVA_STATIC_EXPORT", originalStaticExport);
    }

    expect(calls[0]?.input).toBe(
      "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
    );
  });

  test("skips the same-origin proxy for browser library calls in static export builds", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalAgentEnv = process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL;
    const originalApiEnv = process.env.NEXT_PUBLIC_VIVA_API_URL;
    const originalStaticExport = process.env.NEXT_PUBLIC_VIVA_STATIC_EXPORT;
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, {
        privacy: {
          copy: "Voice recordings and transcripts are not saved.",
          export: { available: false, unavailable_reason: "mutation_auth_required" },
          export_contains_raw_provider_payloads: false,
          raw_audio_persistence: false,
          transcript_persistence: false,
          transcripts_saved: false,
          voice_recordings_saved: false,
        },
        sessions: [],
        study_sets: [],
        user_id: "user-1",
      });
    }) as typeof fetch;

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { origin: "http://localhost:3000" } },
      });
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.example";
      delete process.env.NEXT_PUBLIC_VIVA_API_URL;
      process.env.NEXT_PUBLIC_VIVA_STATIC_EXPORT = "1";

      await fetchVivaLibrarySnapshot({ fetchImpl, userId: "user-1" });
    } finally {
      restoreGlobalProperty("window", originalWindow);
      restoreEnv("NEXT_PUBLIC_VIVA_AGENT_HTTP_URL", originalAgentEnv);
      restoreEnv("NEXT_PUBLIC_VIVA_API_URL", originalApiEnv);
      restoreEnv("NEXT_PUBLIC_VIVA_STATIC_EXPORT", originalStaticExport);
    }

    expect(calls[0]?.input).toBe("https://agent.example/study-sets/library?user_id=user-1");
  });

  test("calls privacy export and delete endpoints without client-side source payloads", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;

    await exportVivaLibraryData({
      apiBaseUrl: "http://127.0.0.1:4318/",
      controlToken: "viva1.control-token",
      fetchImpl,
      userId: "user-1",
    });
    await deleteVivaStudySet("biology-midterm", {
      apiBaseUrl: "http://127.0.0.1:4318/",
      controlToken: "viva1.control-token",
      fetchImpl,
      userId: "user-1",
    });
    await deleteVivaSessionHistory("biology-midterm", "voice-session-1", {
      apiBaseUrl: "http://127.0.0.1:4318/",
      controlToken: "viva1.control-token",
      fetchImpl,
      userId: "user-1",
    });

    expect(calls.map((call) => `${call.init?.method} ${call.input}`)).toEqual([
      "GET http://127.0.0.1:4318/study-sets/export?user_id=user-1",
      "DELETE http://127.0.0.1:4318/study-sets/biology-midterm?user_id=user-1",
      "DELETE http://127.0.0.1:4318/study-sets/biology-midterm/sessions/voice-session-1?user_id=user-1",
    ]);
    expect(calls.every((call) => call.init?.body === undefined)).toBe(true);
    expect(calls.every((call) => call.init?.headers)).toBe(true);
    expect(calls.map((call) => call.init?.headers)).toEqual([
      { "x-viva-library-control-token": "viva1.control-token" },
      { "x-viva-library-control-token": "viva1.control-token" },
      { "x-viva-library-control-token": "viva1.control-token" },
    ]);
  });
});

function restoreGlobalProperty(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  closeCount = 0;
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

  close(event: Partial<CloseEvent> = {}) {
    this.closeCount += 1;
    this.readyState = 3;
    this.emit(
      "close",
      Object.assign(new Event("close"), {
        code: event.code ?? 1000,
        reason: event.reason ?? "",
        wasClean: event.wasClean ?? true,
      }),
    );
  }

  open() {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  message(data: string) {
    this.emit("message", Object.assign(new Event("message"), { data }));
  }

  error() {
    this.emit("error", new Event("error"));
  }

  private emit(type: string, event: Event & { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
