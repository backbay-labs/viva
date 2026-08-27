import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  type AgentSessionConfig,
  type AgentStudySourceReference,
  parseVivaClientFrame,
  parseVivaServerFrame,
  VIVA_AUDIO_MAX_CHUNK_BYTES,
  VIVA_AUDIO_MAX_TURN_BYTES,
  VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
  VIVA_VOICE_PROTOCOL_VERSION,
} from "@viva/core";
import fakeSessionFixture from "../../../agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-runtime-session.json";
import sessionFixture from "../../../agent/fixtures/voice-protocol/v5/seeded-session-config.json";
import readyFixture from "../../../agent/fixtures/voice-protocol/v5/server-ready.json";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/v5/synthetic-runtime-session.json";
import {
  agentProtocolVersion,
  createVivaAgentSessionController,
  deleteVivaSessionHistory,
  deleteVivaStudySet,
  exportVivaLibraryData,
  fetchAuthenticatedStudyProjection,
  fetchVivaAgentReadinessProbe,
  fetchVivaLibrarySnapshot,
  initialVivaAgentSessionState,
  parseVivaAgentMessage,
  VIVA_STUDY_PROJECTION_TIMEOUT_MS,
  vivaAgentHttpBaseUrl,
  vivaAgentProtocols,
  vivaAgentReducer,
  vivaAgentWsUrl,
  vivaApiBaseUrl,
} from "./viva-agent-client";
import { pcm16LeBytesToBase64 } from "./viva-audio-capture";

/**
 * A v5-shaped signed session credential: the `viva1` prefix plus two canonical
 * unpadded base64url segments. `parseVivaClientFrame` checks the SHAPE of the
 * credential on every `session_config`, so a placeholder string is not a valid
 * fixture — and the controller now refuses to send an unauthenticated first
 * frame at all.
 */
const SIGNED_SESSION_CREDENTIAL = "viva1.eyJzZXNzaW9uIjoiZml4dHVyZSJ9.c2lnbmF0dXJlLWZpeHR1cmU";

/** The rotated credential the refresh path exchanges the one above for. */
const REFRESHED_SESSION_CREDENTIAL =
  "viva1.eyJzZXNzaW9uIjoicmVmcmVzaGVkIn0.cmVmcmVzaGVkLXNpZ25hdHVyZQ";

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

  test("controller sends initial session config and command frames", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
    expect(sessionConfig.session_token).toBe(SIGNED_SESSION_CREDENTIAL);
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
    controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
      sequence: 0,
      turnId: "turn-command-frames",
    });
    controller.endAudioTurn({ finalSequence: 0, turnId: "turn-command-frames" });
    controller.cancel();
    controller.stop();
    expect(parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}"))).toEqual({
      client_generation_id: "session_bootstrap-1",
      text: "quiz me",
      type: "text",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    expect(parseVivaClientFrame(JSON.parse(socket.sent[2] ?? "{}")).type).toBe("audio_chunk");
    expect(parseVivaClientFrame(JSON.parse(socket.sent[3] ?? "{}")).type).toBe("audio_end");
    expect(parseVivaClientFrame(JSON.parse(socket.sent[4] ?? "{}")).type).toBe("cancel");
    expect(parseVivaClientFrame(JSON.parse(socket.sent[5] ?? "{}")).type).toBe("stop");
  });

  test("controller clears stale connected state on reconnect", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      sessionToken: SIGNED_SESSION_CREDENTIAL,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      initialState: {
        ...initialVivaAgentSessionState(),
        status: "closed",
        question: {
          concept_id: "oxidative-phosphorylation",
          question_id: "old-question",
          prompt: "Old prompt",
          expected_terms: [],
          follow_up: "old",
          rubric: {
            policy_version: "viva.rubric.v1",
            criteria: [
              {
                claim: "Old claim.",
                concept_id: "oxidative-phosphorylation",
                criterion_id: "crit-old",
                required: true,
                source_id: "src-lecture-5-slide-18",
              },
            ],
          },
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
          concepts: [{ concept_id: "old", label: "Old", status: "strong" }],
          deferred_turns: 0,
          headline: "Old recap",
          next_action: "old",
          review_schedule: [],
          schema: "viva.study_session_recap.v2",
          source_moments: [],
          summary: "Old summary",
          voice_session_id: "voice-session-1",
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
          partial: false,
          recap: {
            concepts: [],
            deferred_turns: 0,
            headline: "Stale recap",
            next_action: "Keep working on the current answer.",
            review_schedule: [],
            schema: "viva.study_session_recap.v2",
            source_moments: [],
            summary: "Old answer recap",
            voice_session_id: "voice-session-1",
          },
        },
      }),
    );

    expect(afterStaleRecap.recap).toBeUndefined();
    expect(afterStaleRecap.phase).toBe("thinking");
    expect(afterStaleRecap.activeResponseId).toBe("response-b");
    expect(afterStaleRecap.staleEvents).toBe(state.staleEvents + 1);
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
          turn_id: "turn-resp-2",
          question: {
            concept_id: "oxidative-phosphorylation",
            rubric: {
              policy_version: "viva.rubric.v1",
              criteria: [
                {
                  claim: "Second question claim.",
                  concept_id: "oxidative-phosphorylation",
                  criterion_id: "crit-q2",
                  required: true,
                  source_id: "src-lecture-5-slide-18",
                },
              ],
            },
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
        sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: REFRESHED_SESSION_CREDENTIAL,
    }) as unknown as FakeWebSocket;
    expect(refreshed.protocols).toEqual(vivaAgentProtocols(REFRESHED_SESSION_CREDENTIAL));
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
    expect(refreshConfig.session_token).toBe(REFRESHED_SESSION_CREDENTIAL);
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
      sessionToken: SIGNED_SESSION_CREDENTIAL,
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
    expect(state.evaluation?.concept_status).toBe("strong");
    expect(state.currentSource?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.sources[0]?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.currentConceptStatus).toBe("strong");
    expect(state.conceptStatuses["oxidative-phosphorylation"]).toBe("strong");
    expect(state.conceptStatusEvents).toEqual([
      {
        conceptId: "oxidative-phosphorylation",
        responseId: "response-1-generation-1",
        status: "strong",
      },
    ]);
    expect(state.manuscriptIntents.map((event) => event.intent.type)).toEqual([
      "scene_intent",
      "entity_intent",
    ]);
    expect(state.recap?.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");
    expect(state.cancelledResponseIds).toContain("response-2-generation-1");

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
          turn_id: "turn-response-next",
          question: {
            ...currentQuestion,
            concept_id: "oxidative-phosphorylation",
            rubric: {
              policy_version: "viva.rubric.v1",
              criteria: [
                {
                  claim: "Next question claim.",
                  concept_id: "oxidative-phosphorylation",
                  criterion_id: "crit-q-next",
                  required: true,
                  source_id: "src-lecture-5-slide-18",
                },
              ],
            },
            question_id: "q-next",
            prompt: "Next question",
          },
        },
      }),
    );
    expect(nextQuestion.currentSource).toBeUndefined();
    expect(nextQuestion.currentConceptStatus).toBeUndefined();
    expect(nextQuestion.sources).toEqual([]);
    expect(nextQuestion.conceptStatuses["oxidative-phosphorylation"]).toBe("strong");
  });

  test("reducer stores manuscript intents and suppresses stale intent events", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    expect(state.activeResponseId).toBe("response-1-generation-1");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1-generation-1",
          intent: { type: "scene_intent", register: "examining", emphasis: "measured" },
        },
      }),
    );
    expect(state.manuscriptIntents).toEqual([
      {
        responseId: "response-1-generation-1",
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

    // Every response id in this canonical session carries the one client
    // generation the browser stamps on every frame it sends, so the reducer must
    // accept the whole turn rather than treating it as a stale response.
    expect(state.audio[0]).toEqual({
      responseId: "response-1-generation-1",
      frame: { pcm16_base64: "AQIDBA==" },
    });
    expect(state.finalTranscript).toBe("NADH donates electrons to the electron transport chain.");
    expect(state.evaluation?.answer_text).toBe(
      "NADH donates electrons to the electron transport chain.",
    );
    expect(state.sources[0]?.source_id).toBe("src-lecture-5-slide-18");
    expect(state.recap?.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");
    expect(state.cancelledResponseIds).toContain("response-2-generation-1");
    expect(state.staleEvents).toBe(0);
  });

  test("reducer suppresses events for a cancelled active response", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 3).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }
    expect(state.activeResponseId).toBe("response-1-generation-1");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "response-1-generation-1" },
      }),
    );
    const afterCancelledDelta = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "transcript_delta",
          response_id: "response-1-generation-1",
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
    expect(state.activeResponseId).toBe("response-1-generation-1");
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
    expect(state.cancelledResponseIds).toContain("response-1-generation-1");

    const staleFrames = [
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "answer_evaluated",
          response_id: "response-1-generation-1",
          evaluation: {
            question_id: "q-oxidative-phosphorylation-nadh",
            answer_text: "stale answer",
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
          response_id: "response-1-generation-1",
          source,
        },
      }),
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "recap_ready",
          response_id: "response-1-generation-1",
          partial: false,
          recap: {
            concepts: [
              { concept_id: "oxidative-phosphorylation", label: "NADH", status: "strong" },
            ],
            deferred_turns: 0,
            headline: "Stale recap",
            next_action: "Do not surface stale recap.",
            review_schedule: [],
            schema: "viva.study_session_recap.v2",
            source_moments: [
              { response_id: "response-1-generation-1", source_id: "src-lecture-5-slide-18" },
            ],
            summary: "Stale summary",
            voice_session_id: "voice-session-1",
          },
        },
      }),
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "audio_delta",
          response_id: "response-1-generation-1",
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
        event: { type: "cancellation", response_id: "response-1-generation-1" },
      }),
    );

    const afterCancelledIntent = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1-generation-1",
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
    expect(state.activeResponseId).toBe("response-1-generation-1");

    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: { type: "cancellation", response_id: "response-1-generation-1" },
      }),
    );
    state = vivaAgentReducer(
      state,
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "transcript_final",
          response_id: "response-2-generation-1",
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

/**
 * CRIT-AUDIO-01 browser seam: bounded v5 chunk streaming with a retained turn
 * ledger. Every case here runs against the exact `VivaAudioSendResult` union —
 * a boolean "sent" answer cannot express retained bytes, so the union is what is
 * asserted, never a truthy shortcut.
 */
describe("bounded audio turn ledger", () => {
  function openControllerWithLedger() {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
      url: "ws://localhost:4318/ws",
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));
    return { controller, socket };
  }

  function pcm16(byteLength: number, seed = 0): Uint8Array {
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) bytes[index] = (index + seed) % 251;
    return bytes;
  }

  // Drops the session_config frame so assertions read the audio lifecycle only.
  function audioFrames(socket: FakeWebSocket) {
    return socket.sent.slice(1).map((raw) => parseVivaClientFrame(JSON.parse(raw)));
  }

  function acceptedFrame(input: { generationId?: string; turnId: string; finalSequence: number }) {
    return JSON.stringify({
      client_generation_id: input.generationId ?? "session_bootstrap-1",
      final_sequence: input.finalSequence,
      turn_id: input.turnId,
      type: "audio_turn_accepted",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
  }

  test("serializes 960-byte microphone chunks as contiguous protocol v5 frames", () => {
    const { controller, socket } = openControllerWithLedger();

    const results = [0, 1, 2].map((sequence) =>
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960, sequence), sequence, turnId: "turn-01" }),
    );
    const end = controller.endAudioTurn({ finalSequence: 2, turnId: "turn-01" });

    expect(results).toEqual([
      { acceptedThroughSequence: 0, status: "sent" },
      { acceptedThroughSequence: 1, status: "sent" },
      { acceptedThroughSequence: 2, status: "sent" },
    ]);
    expect(end).toEqual({ acceptedThroughSequence: 2, status: "sent" });
    expect(audioFrames(socket).map((frame) => frame.type)).toEqual([
      "audio_chunk",
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    expect(audioFrames(socket)[0]).toEqual({
      client_generation_id: "session_bootstrap-1",
      frame: { pcm16_base64: pcm16LeBytesToBase64(pcm16(960, 0)) },
      sequence: 0,
      turn_id: "turn-01",
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    expect(audioFrames(socket)[3]).toEqual({
      client_generation_id: "session_bootstrap-1",
      final_sequence: 2,
      turn_id: "turn-01",
      type: "audio_end",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    for (const raw of socket.sent) {
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(
        VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
      );
    }
  });

  test("a maximum 8,192-byte chunk still fits inside the unchanged 64 KiB text cap", () => {
    const { controller, socket } = openControllerWithLedger();

    expect(
      controller.sendAudioChunk({
        pcm16Bytes: pcm16(VIVA_AUDIO_MAX_CHUNK_BYTES),
        sequence: 0,
        turnId: "turn-max-chunk",
      }),
    ).toEqual({ acceptedThroughSequence: 0, status: "sent" });
    expect(new TextEncoder().encode(socket.sent[1] ?? "").byteLength).toBeLessThan(
      VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
    );
  });

  test("retains chunks at the 64 KiB high-water mark and never lets audio_end overtake them", () => {
    const { controller, socket } = openControllerWithLedger();

    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-02" }),
    ).toEqual({ acceptedThroughSequence: 0, status: "sent" });

    socket.bufferedAmount = VIVA_VOICE_MAX_TEXT_FRAME_BYTES;
    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960, 3), sequence: 1, turnId: "turn-02" }),
    ).toEqual({ acceptedThroughSequence: 0, retainedFromSequence: 0, status: "pending" });
    expect(controller.endAudioTurn({ finalSequence: 1, turnId: "turn-02" })).toEqual({
      acceptedThroughSequence: 0,
      retainedFromSequence: 0,
      status: "pending",
    });
    expect(audioFrames(socket).map((frame) => frame.type)).toEqual(["audio_chunk"]);

    socket.bufferedAmount = 0;
    expect(controller.retryPendingAudio()).toEqual({
      acceptedThroughSequence: 1,
      status: "sent",
    });
    expect(audioFrames(socket).map((frame) => frame.type)).toEqual([
      "audio_chunk",
      "audio_chunk",
      "audio_end",
    ]);
    expect(audioFrames(socket)[1]).toEqual({
      client_generation_id: "session_bootstrap-1",
      frame: { pcm16_base64: pcm16LeBytesToBase64(pcm16(960, 3)) },
      sequence: 1,
      turn_id: "turn-02",
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
  });

  test("a closed socket retains from the first unserialized sequence and stays retryable", () => {
    const { controller, socket } = openControllerWithLedger();
    controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-03" });
    socket.close({ code: 1006, reason: "", wasClean: false });

    const closed = controller.sendAudioChunk({
      pcm16Bytes: pcm16(960, 5),
      sequence: 1,
      turnId: "turn-03",
    });

    expect(closed).toEqual({
      acceptedThroughSequence: 0,
      error: { code: "socket_closed", message: "Viva voice WebSocket is not open" },
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(controller.endAudioTurn({ finalSequence: 1, turnId: "turn-03" })).toEqual(closed);
    expect(audioFrames(socket).map((frame) => frame.type)).toEqual(["audio_chunk"]);
    // The close never clears the ledger: the same turn is still the active one.
    expect(() =>
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-03-b" }),
    ).toThrow("audio_turn_limit");
  });

  test("only a matching audio_turn_accepted releases the bounded ledger", () => {
    const { controller, socket } = openControllerWithLedger();
    controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-04" });
    controller.endAudioTurn({ finalSequence: 0, turnId: "turn-04" });

    socket.message(acceptedFrame({ finalSequence: 1, turnId: "turn-04" }));
    expect(controller.getState().acceptedAudioTurn).toBeUndefined();
    socket.message(acceptedFrame({ finalSequence: 0, turnId: "turn-other" }));
    expect(controller.getState().acceptedAudioTurn).toBeUndefined();
    socket.message(
      acceptedFrame({ finalSequence: 0, generationId: "some-other-generation", turnId: "turn-04" }),
    );
    expect(controller.getState().acceptedAudioTurn).toBeUndefined();
    expect(controller.getState().staleEvents).toBe(3);
    expect(() =>
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-05" }),
    ).toThrow("audio_turn_limit");

    socket.message(acceptedFrame({ finalSequence: 0, turnId: "turn-04" }));

    expect(controller.getState().acceptedAudioTurn).toEqual({
      finalSequence: 0,
      turnId: "turn-04",
    });
    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-05" }),
    ).toEqual({ acceptedThroughSequence: 0, status: "sent" });
  });

  test("fails closed on a second turn, malformed chunk, or noncontiguous sequence", () => {
    const { controller, socket } = openControllerWithLedger();
    controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-06" });

    expect(() =>
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-07" }),
    ).toThrow("audio_turn_limit");
    expect(() =>
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 2, turnId: "turn-06" }),
    ).toThrow("audio_turn_limit");
    expect(() =>
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-06" }),
    ).toThrow("audio_turn_limit");
    expect(() =>
      controller.sendAudioChunk({
        pcm16Bytes: pcm16(VIVA_AUDIO_MAX_CHUNK_BYTES + 2),
        sequence: 1,
        turnId: "turn-06",
      }),
    ).toThrow("audio_queue_limit");
    expect(() =>
      controller.sendAudioChunk({ pcm16Bytes: new Uint8Array(0), sequence: 1, turnId: "turn-06" }),
    ).toThrow("audio_queue_limit");
    expect(() =>
      controller.sendAudioChunk({
        pcm16Bytes: new Uint8Array(961),
        sequence: 1,
        turnId: "turn-06",
      }),
    ).toThrow("audio_queue_limit");
    expect(() => controller.endAudioTurn({ finalSequence: 3, turnId: "turn-06" })).toThrow(
      "audio_turn_limit",
    );
    expect(() => controller.endAudioTurn({ finalSequence: 0, turnId: "turn-07" })).toThrow(
      "audio_turn_limit",
    );

    // Nothing above grew the ledger: the next contiguous chunk is still sequence 1.
    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960, 9), sequence: 1, turnId: "turn-06" }),
    ).toEqual({ acceptedThroughSequence: 1, status: "sent" });
    expect(audioFrames(socket).map((frame) => frame.type)).toEqual(["audio_chunk", "audio_chunk"]);
  });

  test("caps the retained turn at 2,160,000 raw bytes across pending, retry, and cancel cycles", () => {
    const { controller, socket } = openControllerWithLedger();
    socket.bufferedAmount = VIVA_VOICE_MAX_TEXT_FRAME_BYTES;

    let sequence = 0;
    let retainedBytes = 0;
    while (retainedBytes + VIVA_AUDIO_MAX_CHUNK_BYTES <= VIVA_AUDIO_MAX_TURN_BYTES) {
      controller.sendAudioChunk({
        pcm16Bytes: new Uint8Array(VIVA_AUDIO_MAX_CHUNK_BYTES),
        sequence,
        turnId: "turn-08",
      });
      retainedBytes += VIVA_AUDIO_MAX_CHUNK_BYTES;
      sequence += 1;
    }
    const tailBytes = VIVA_AUDIO_MAX_TURN_BYTES - retainedBytes;
    expect(tailBytes).toBeGreaterThan(0);

    expect(
      controller.sendAudioChunk({
        pcm16Bytes: new Uint8Array(tailBytes),
        sequence,
        turnId: "turn-08",
      }),
    ).toEqual({ acceptedThroughSequence: null, retainedFromSequence: 0, status: "pending" });
    expect(() =>
      controller.sendAudioChunk({
        pcm16Bytes: new Uint8Array(2),
        sequence: sequence + 1,
        turnId: "turn-08",
      }),
    ).toThrow("audio_queue_limit");
    expect(audioFrames(socket)).toHaveLength(0);

    socket.bufferedAmount = 0;
    expect(controller.retryPendingAudio()).toEqual({
      acceptedThroughSequence: sequence,
      status: "sent",
    });
    expect(audioFrames(socket)).toHaveLength(sequence + 1);
    // Serialized bytes stay retained until acceptance, so the cap still holds.
    expect(() =>
      controller.sendAudioChunk({
        pcm16Bytes: new Uint8Array(2),
        sequence: sequence + 1,
        turnId: "turn-08",
      }),
    ).toThrow("audio_queue_limit");

    controller.cancelAudioTurn("turn-08");
    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-09" }),
    ).toEqual({ acceptedThroughSequence: 0, status: "sent" });
  });

  test("cancelAudioTurn scopes the cancel frame and always clears local bytes", () => {
    const { controller, socket } = openControllerWithLedger();
    controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-10" });

    // A cancel for a different turn is never permission to discard the live one.
    controller.cancelAudioTurn("turn-not-active");
    expect(audioFrames(socket).map((frame) => frame.type)).toEqual(["audio_chunk"]);

    controller.cancelAudioTurn("turn-10");
    expect(audioFrames(socket).at(-1)).toEqual({
      client_generation_id: "session_bootstrap-1",
      turn_id: "turn-10",
      type: "cancel",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-11" }),
    ).toEqual({ acceptedThroughSequence: 0, status: "sent" });

    socket.close();
    controller.cancelAudioTurn("turn-11");
    expect(audioFrames(socket).filter((frame) => frame.type === "cancel")).toHaveLength(1);
    // Local bytes were still released, so a fresh turn is accepted on reconnect.
    expect(
      controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-12" }).status,
    ).toBe("socket_closed");
  });

  test("keeps raw PCM and base64 payloads out of send results, errors, and state", () => {
    const { controller, socket } = openControllerWithLedger();
    const bytes = pcm16(960, 17);
    const encoded = pcm16LeBytesToBase64(bytes);
    controller.sendAudioChunk({ pcm16Bytes: bytes, sequence: 0, turnId: "turn-13" });
    socket.close({ code: 1006, reason: "", wasClean: false });
    const closed = controller.sendAudioChunk({
      pcm16Bytes: pcm16(960, 23),
      sequence: 1,
      turnId: "turn-13",
    });

    expect(JSON.stringify(closed)).not.toContain(encoded);
    expect(closed.status === "socket_closed" ? closed.error.message : "").toBe(
      "Viva voice WebSocket is not open",
    );
    expect(JSON.stringify(controller.getState())).not.toContain(encoded);
    expect(JSON.stringify(controller.getState())).not.toContain(
      pcm16LeBytesToBase64(pcm16(960, 23)),
    );
  });

  test("an audio turn end is the pending submission, and a cancel releases it", () => {
    const { controller } = openControllerWithLedger();
    controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-14" });
    expect(controller.getState().pendingSubmission).toBeUndefined();

    controller.endAudioTurn({ finalSequence: 0, turnId: "turn-14" });
    expect(controller.getState().pendingSubmission).toEqual({
      generationId: "session_bootstrap-1",
      kind: "audio",
    });
    expect(controller.sendText("typed while audio is pending")).toBe(false);

    controller.cancelAudioTurn("turn-14");
    expect(controller.getState().pendingSubmission).toBeUndefined();
    expect(controller.sendText("typed after cancel")).toBe(true);
  });

  test("a generation replacement retains the ledger without replaying it", () => {
    const { controller } = openControllerWithLedger();
    controller.sendAudioChunk({ pcm16Bytes: pcm16(960), sequence: 0, turnId: "turn-15" });

    const next = controller.connect("socket_retry") as unknown as FakeWebSocket;
    next.open();

    const result = controller.sendAudioChunk({
      pcm16Bytes: pcm16(960, 4),
      sequence: 1,
      turnId: "turn-15",
    });

    expect(result).toEqual({
      acceptedThroughSequence: 0,
      error: { code: "socket_closed", message: "Viva voice generation was replaced" },
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    // Only the session_config frame reached the replacement socket — no replay.
    expect(next.sent.map((raw) => parseVivaClientFrame(JSON.parse(raw)).type)).toEqual([
      "session_config",
    ]);
  });

  test("retryPendingAudio fails closed when no audio turn is active", () => {
    const { controller } = openControllerWithLedger();

    expect(() => controller.retryPendingAudio()).toThrow("audio_turn_limit");
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  bufferedAmount = 0;
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

  // Real browsers throw on a send that is not in the OPEN state; the fake mirrors
  // that so a controller regression that serializes into a closed socket is loud
  // instead of silently "sent".
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("FakeWebSocket.send called while the socket was not open");
    }
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

/**
 * `WEBSESSION-DATA-01` — the authenticated study projection client.
 *
 * The projection is the only study/session read model; there is no library
 * metadata fallback and no seed overlay to fall through to.
 */
describe("authenticated study projection client", () => {
  const SENTINEL = "VIVA_PROJECTION_SENTINEL_TOKEN";

  function thermoProjection(overrides: Record<string, unknown> = {}) {
    return {
      activeQuestion: {
        conceptId: "enthalpy",
        id: "q-enthalpy-1",
        prompt: "Why is enthalpy a state function?",
        sourceCitations: [
          {
            confidence: "high",
            documentId: "chem-lec-3",
            label: "Lecture 3 · slide 11",
            sourceId: "src-chem-lec-3-slide-11",
            span: "slide:11",
          },
        ],
      },
      concepts: [
        {
          dueAt: "2026-08-27T09:00:00.000Z",
          id: "enthalpy",
          label: "Enthalpy",
          lastReviewedAt: "2026-08-20T09:00:00.000Z",
          status: "shaky",
        },
        {
          dueAt: "2026-08-26T09:00:00.000Z",
          id: "gibbs-free-energy",
          label: "Gibbs free energy",
          lastReviewedAt: null,
          status: "missed",
        },
      ],
      questionProgress: { completed: 2, total: 5 },
      reviewSchedule: [
        {
          authority: "server_persisted_fsrs",
          conceptId: "enthalpy",
          dueAt: "2026-08-27T09:00:00.000Z",
        },
        {
          authority: "server_persisted_fsrs",
          conceptId: "gibbs-free-energy",
          dueAt: "2026-08-26T09:00:00.000Z",
        },
      ],
      session: { goal: null, id: "voice-session-9", mode: "quiz" },
      studySet: {
        course: "CHEM-401",
        examLabel: "Oral final",
        id: "thermo-401",
        ingestionStatus: "ready",
        title: "Thermodynamic State Functions",
      },
      version: 1,
      ...overrides,
    };
  }

  function request(signal = new AbortController().signal) {
    return {
      accessToken: "viva1.projection-access-token",
      signal,
      studySetId: "thermo 401/α",
      voiceSessionId: "voice session 9",
    };
  }

  type FetchCall = { init?: RequestInit; url: string };

  function recordingFetch(responses: Array<() => Response | Promise<Response>>) {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, url: String(url) });
      const next = responses[Math.min(calls.length, responses.length) - 1];
      if (!next) throw new Error("no response configured");
      return next();
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  function projectionResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", ...headers },
      status,
    });
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test("sends the exact same-origin request and carries no credential in the URL", async () => {
    const { calls, fetchImpl } = recordingFetch([() => projectionResponse(thermoProjection())]);
    const signal = new AbortController().signal;
    const result = await fetchAuthenticatedStudyProjection(request(signal), fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "/api/viva-session/projection?study_set_id=thermo+401%2F%CE%B1&voice_session_id=voice+session+9",
    );
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer viva1.projection-access-token",
    );
    // `Sec-Fetch-Site` is a forbidden header name: the browser's own same-origin
    // fetch metadata is the proof Plan 11's guard reads, and a script that tried
    // to set it would simply have it dropped.
    expect(new Headers(calls[0]?.init?.headers).get("sec-fetch-site")).toBe(null);
    expect(calls[0]?.url).not.toContain("viva1.");
    // The attempt carries its OWN signal — the caller's is forwarded into it,
    // never handed to `fetch` directly, so one attempt's deadline can never
    // cancel a later one.
    expect(calls[0]?.init?.signal).not.toBe(signal);
    expect(calls[0]?.init?.signal instanceof AbortSignal).toBe(true);
    expect(result.status).toBe("ready");
  });

  test("forwards the caller's abort into the in-flight attempt", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const pending = fetchAuthenticatedStudyProjection(request(controller.signal), ((
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }) as typeof fetch);

    await Promise.resolve();
    expect(observed?.aborted).toBe(false);
    controller.abort();
    expect(observed?.aborted).toBe(true);
    expect(await pending).toEqual({ cause: "unavailable", status: "failed" });
  });

  test("returns the validated projection, reconstructed and frozen", async () => {
    const { fetchImpl } = recordingFetch([() => projectionResponse(thermoProjection())]);
    const result = await fetchAuthenticatedStudyProjection(request(), fetchImpl);

    if (result.status !== "ready") throw new Error("expected a ready projection");
    expect(result.projection).toEqual(thermoProjection());
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(result.projection.reviewSchedule[0]?.authority).toBe("server_persisted_fsrs");
  });

  test("maps each locked failure status to its exact sanitized cause", async () => {
    const cases: Array<[number, string, Record<string, string>]> = [
      [400, "invalid_request", {}],
      [401, "unauthorized", {}],
      [403, "unauthorized", {}],
      [404, "not_found", {}],
      [503, "unavailable", {}],
    ];
    for (const [status, cause, headers] of cases) {
      const { calls, fetchImpl } = recordingFetch([
        () => projectionResponse({ error: "refused", title: SENTINEL }, status, headers),
      ]);
      const result = await fetchAuthenticatedStudyProjection(request(), fetchImpl);

      expect(result).toEqual({ cause, status: "failed" });
      // One request each: an answer is not an outage, and the shared-store 503
      // has no agent fallback to try.
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    }
  });

  test("carries a bounded integer Retry-After through a rate limit and nothing else", async () => {
    const limited = recordingFetch([
      () =>
        projectionResponse({ error: "session_projection_rate_limited" }, 429, {
          "retry-after": "12",
        }),
    ]);
    const dateForm = recordingFetch([
      () =>
        projectionResponse({ error: "session_projection_rate_limited" }, 429, {
          "retry-after": "Wed, 26 Aug 2026 09:00:00 GMT",
        }),
    ]);

    expect(await fetchAuthenticatedStudyProjection(request(), limited.fetchImpl)).toEqual({
      cause: "rate_limited",
      retryAfterSeconds: 12,
      status: "failed",
    });
    expect(await fetchAuthenticatedStudyProjection(request(), dateForm.fetchImpl)).toEqual({
      cause: "rate_limited",
      status: "failed",
    });
    expect(limited.calls).toHaveLength(1);
    expect(dateForm.calls).toHaveLength(1);
  });

  test("retries once after 502 and once after 504, then terminates", async () => {
    const recovered = recordingFetch([
      () => projectionResponse({ error: "viva_session_projection_unavailable" }, 502),
      () => projectionResponse(thermoProjection()),
    ]);
    const exhausted502 = recordingFetch([
      () => projectionResponse({ error: "viva_session_projection_unavailable" }, 502),
      () => projectionResponse({ error: "viva_session_projection_unavailable" }, 502),
    ]);
    const exhausted504 = recordingFetch([
      () => projectionResponse({ error: "viva_session_projection_timeout" }, 504),
      () => projectionResponse({ error: "viva_session_projection_timeout" }, 504),
    ]);

    expect((await fetchAuthenticatedStudyProjection(request(), recovered.fetchImpl)).status).toBe(
      "ready",
    );
    expect(recovered.calls).toHaveLength(2);
    expect(await fetchAuthenticatedStudyProjection(request(), exhausted502.fetchImpl)).toEqual({
      cause: "unavailable",
      status: "failed",
    });
    expect(exhausted502.calls).toHaveLength(2);
    expect(await fetchAuthenticatedStudyProjection(request(), exhausted504.fetchImpl)).toEqual({
      cause: "timeout",
      status: "failed",
    });
    expect(exhausted504.calls).toHaveLength(2);
  });

  test("each attempt owns an independent 8,000 ms deadline", async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    let settleFirst: ((response: Response) => void) | undefined;
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) {
        return new Promise<Response>((resolve, reject) => {
          settleFirst = resolve;
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return Promise.resolve(projectionResponse(thermoProjection()));
    }) as typeof fetch;

    const pending = fetchAuthenticatedStudyProjection(request(), fetchImpl);
    jest.advanceTimersByTime(VIVA_STUDY_PROJECTION_TIMEOUT_MS - 1);
    expect(signals[0]?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signals[0]?.aborted).toBe(true);
    // A client-side deadline is not a 502/504, so it terminates rather than
    // spending a second attempt.
    expect(await pending).toEqual({ cause: "timeout", status: "failed" });
    expect(signals).toHaveLength(1);
    expect(typeof settleFirst).toBe("function");
  });

  test("an invalid or non-JSON 200 is invalid_projection and leaks no upstream text", async () => {
    const wrongAuthority = recordingFetch([
      () =>
        projectionResponse(
          thermoProjection({
            reviewSchedule: [
              {
                authority: "core_fsrs_read_time",
                conceptId: "enthalpy",
                dueAt: "2026-08-27T09:00:00.000Z",
              },
              {
                authority: "server_persisted_fsrs",
                conceptId: "gibbs-free-energy",
                dueAt: "2026-08-26T09:00:00.000Z",
              },
            ],
          }),
        ),
    ]);
    const unknownField = recordingFetch([
      () => projectionResponse(thermoProjection({ smuggled: SENTINEL })),
    ]);
    const notJson = recordingFetch([() => new Response(`not json ${SENTINEL}`, { status: 200 })]);

    for (const attempt of [wrongAuthority, unknownField, notJson]) {
      const result = await fetchAuthenticatedStudyProjection(request(), attempt.fetchImpl);
      expect(result).toEqual({ cause: "invalid_projection", status: "failed" });
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(attempt.calls).toHaveLength(1);
    }
  });

  test("a network failure is unavailable, never a thrown fetch message", async () => {
    const result = await fetchAuthenticatedStudyProjection(request(), (async () => {
      throw new Error(`ECONNREFUSED ${SENTINEL}`);
    }) as typeof fetch);

    expect(result).toEqual({ cause: "unavailable", status: "failed" });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});
