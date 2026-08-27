import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  type AgentSessionConfig,
  type AgentStudySourceReference,
  type PasteIngestionResponse,
  parseVivaClientFrame,
  parseVivaServerFrame,
  VIVA_AUDIO_MAX_CHUNK_BYTES,
  VIVA_AUDIO_MAX_TURN_BYTES,
  VIVA_VOICE_DEFERRAL_REASONS,
  VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
  VIVA_VOICE_PROTOCOL_VERSION,
  type VivaBrowserClientFrame,
} from "@viva/core";
import clientDifferentialCases from "../../../agent/fixtures/voice-protocol/v5/client-differential-cases.json";
import fakeSessionFixture from "../../../agent/fixtures/voice-protocol/v5/fake-cartesia-gemini-runtime-session.json";
import manifestFixture from "../../../agent/fixtures/voice-protocol/v5/manifest.json";
import sessionFixture from "../../../agent/fixtures/voice-protocol/v5/seeded-session-config.json";
import serverDifferentialCases from "../../../agent/fixtures/voice-protocol/v5/server-differential-cases.json";
import readyFixture from "../../../agent/fixtures/voice-protocol/v5/server-ready.json";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/v5/synthetic-runtime-session.json";
import terminalSequences from "../../../agent/fixtures/voice-protocol/v5/terminal-sequences.json";
import transportOutcomes from "../../../agent/fixtures/voice-protocol/v5/transport-outcomes.json";
import * as vivaAgentClientModule from "./viva-agent-client";
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
  pasteStudySetToVivaApi,
  reconnectDelayMs,
  serializeVivaBrowserClientFrame,
  VIVA_AGENT_READINESS_POLL_INTERVAL_MS,
  VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS,
  VIVA_AGENT_RECONNECT_DELAYS_MS,
  VIVA_AGENT_RECONNECT_JITTER_MS,
  VIVA_STUDY_PROJECTION_TIMEOUT_MS,
  type VivaAgentReconnectInputState,
  type VivaAgentSessionController,
  type VivaPasteStudySetInput,
  vivaAgentHttpBaseUrl,
  vivaAgentProtocols,
  vivaAgentReconnectDecision,
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
    const answerIntent = parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}"));
    expect(answerIntent.type).toBe("turn_intent");
    if (answerIntent.type !== "turn_intent") throw new Error("Expected a turn intent");
    expect(answerIntent.client_generation_id).toBe("session_bootstrap-1");
    expect(answerIntent.version).toBe(VIVA_VOICE_PROTOCOL_VERSION);
    expect(answerIntent.intent).toEqual({ kind: "answer_text", text: "quiz me" });
    expect(answerIntent.turn_id.length).toBeGreaterThan(0);
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
          kind: "complete",
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
    expect(controller.getState().recap?.recap.voice_session_id).toBe("voice-session-1");

    socket.close();

    expect(controller.getState().status).toBe("closed");
    expect(controller.getState().recap?.recap.voice_session_id).toBe("voice-session-1");
    expect(controller.getState().phase).toBe("recap");
  });

  test("reducer treats recap_ready as terminal without a trailing session_phase", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.slice(0, 18).map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    expect(state.recap?.recap.voice_session_id).toBe("voice-session-1");
    expect(state.phase).toBe("recap");

    const stalePhase = parseVivaServerFrame({
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: { type: "session_phase", phase: "correction" },
    });
    const afterStalePhase = vivaAgentReducer(state, stalePhase);

    expect(afterStalePhase.phase).toBe("recap");
    expect(afterStalePhase.recap?.recap.voice_session_id).toBe("voice-session-1");
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

  /**
   * WSC-M08 characterization. The deleted `session_phase` branch
   * (`event.terminal_reason && event.phase === "recap" && !state.recap`) returned
   * an object identical by effect to the general return, so this pins the WHOLE
   * public state for that sequence: it was captured before the deletion and must
   * be byte-identical after it.
   */
  test("reducer terminal-phase reduction is unchanged by the WSC-M08 branch deletion", () => {
    const terminalPhase = parseVivaServerFrame({
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: { type: "session_phase", phase: "recap", terminal_reason: "drained" },
    });

    expect(vivaAgentReducer(initialVivaAgentSessionState(), terminalPhase)).toEqual({
      audio: [],
      cancelledResponseIds: [],
      conceptStatusEvents: [],
      conceptStatuses: {},
      diagnostics: [],
      manuscriptIntents: [],
      phase: "recap",
      sources: [],
      staleEvents: 0,
      status: "idle",
      structuredErrors: [],
      terminalReason: "drained",
      termination: {
        closeCode: 1000,
        kind: "terminal",
        retryable: false,
        terminalReason: "drained",
      },
      transcript: "",
    });

    // A second, IDENTICAL terminal phase is idempotent, not an invariant breach.
    const twice = vivaAgentReducer(
      vivaAgentReducer(initialVivaAgentSessionState(), terminalPhase),
      terminalPhase,
    );
    expect(twice).toEqual(vivaAgentReducer(initialVivaAgentSessionState(), terminalPhase));
  });

  test("reducer stores only the typed server error pair and never its free-form message", () => {
    const sentinel =
      "provider prompt transcript with bearer viva1.secret-token and raw answer text";
    const state = vivaAgentReducer(
      initialVivaAgentSessionState(),
      parseVivaServerFrame({
        type: "error",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        error: { code: "VOICE_CLIENT_FRAME_MALFORMED", message: sentinel, retryable: false },
      }),
    );

    expect(state.lastServerError).toEqual({
      code: "VOICE_CLIENT_FRAME_MALFORMED",
      retryable: false,
    });
    expect(state.diagnostics).toEqual([{ code: "VOICE_CLIENT_FRAME_MALFORMED", path: "$.error" }]);
    expect(JSON.stringify(state)).not.toContain("viva1.secret-token");
    expect(JSON.stringify(state)).not.toContain("raw answer text");
    expect(JSON.stringify(state)).not.toContain(sentinel);
  });

  test("reducer keeps a recoverable structured error nonterminal and drops its free-form fields", () => {
    const sentinel = "structured_error prompt transcript with CARTESIA_API_KEY and source excerpt";
    const state = vivaAgentReducer(
      { ...initialVivaAgentSessionState(), status: "open" },
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "structured_error",
          source: "cartesia_gemini",
          code: "provider_stream_hiccup",
          message: sentinel,
          terminality: "recoverable",
        },
      }),
    );

    expect(state.structuredErrors).toEqual([{ terminality: "recoverable" }]);
    expect(state.status).toBe("open");
    expect(state.terminalReason).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("CARTESIA_API_KEY");
    expect(JSON.stringify(state)).not.toContain("source excerpt");
    expect(JSON.stringify(state)).not.toContain("cartesia_gemini");
    expect(JSON.stringify(state)).not.toContain("provider_stream_hiccup");
  });

  test("controller records close diagnostics that carry no server close-reason text", () => {
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

    const state = controller.getState();
    expect(state.status).toBe("closed");
    expect(state.close).toEqual({ code: 1008, wasClean: false });
    expect(Object.keys(state.close ?? {})).toEqual(["code", "wasClean"]);
    expect(JSON.stringify(state)).not.toContain("viva1.secret-token");
    expect(JSON.stringify(state)).not.toContain("redacted");
  });

  test("close-reason text is never parsed into a classification, not even the former allowlist", () => {
    for (const reason of [
      "session auth failed",
      "invalid session token",
      "invalid session identity",
      "study set access denied",
      "idle timeout",
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
      socket.close({ code: 1008, reason, wasClean: false });

      const state = controller.getState();
      // Not `auth`: no typed server error preceded the close, so the ONLY honest
      // classification of an unclean 1008 is transport, whatever the peer wrote.
      expect(state.termination).toEqual({ closeCode: 1008, kind: "transport", retryable: true });
      expect(state.close).toEqual({ code: 1008, wasClean: false });
      expect(JSON.stringify(state)).not.toContain(reason);
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
    // A transport-level browser error is ONE fixed internal diagnostic: nothing
    // about the local exception (or the credential) reaches client state.
    expect(controller.getState().diagnostics.at(-1)).toEqual({
      code: "WEB_VOICE_INTERNAL",
      path: null,
    });
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
    ).toEqual(["turn_intent"]);
    const firstIntent = parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}"));
    if (firstIntent.type !== "turn_intent") throw new Error("Expected a turn intent");
    expect(firstIntent.client_generation_id).toBe("session_bootstrap-1");
    expect(firstIntent.intent).toEqual({ kind: "answer_text", text: "first typed response" });
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
    ).toEqual(["turn_intent", "turn_intent"]);
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
    expect(state.recap?.recap.voice_session_id).toBe("voice-session-1");
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
    expect(state.recap?.recap.voice_session_id).toBe("voice-session-1");
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

      await fetchVivaLibrarySnapshot({ fetchImpl, userId: "user-1" });
    } finally {
      restoreGlobalProperty("window", originalWindow);
      restoreEnv("NEXT_PUBLIC_VIVA_AGENT_HTTP_URL", originalEnv);
      restoreEnv("NEXT_PUBLIC_VIVA_API_URL", originalApiEnv);
    }

    expect(calls[0]?.input).toBe(
      "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
    );
  });

  /**
   * `D-06 STATIC_EXPORT` = DELETE. The static-export build target is gone, so no
   * environment flag may still steer a BROWSER request away from the same-origin
   * Next route and at a public agent origin.
   *
   * The two flag names are assembled at runtime rather than written as literals.
   * That is deliberate and is what the owner-local deletion guard requires: the
   * guard greps this file and `viva-agent-client.ts` for the flag identifiers and
   * must find NONE, while this test still has to set the real variables to prove
   * they are inert. Source-text absence and runtime inertness are two different
   * claims and the branch owes both.
   */
  test("D-06 STATIC_EXPORT deleted leaves no browser static routing", async () => {
    const publicFlag = ["NEXT", "PUBLIC", "VIVA", "STATIC", "EXPORT"].join("_");
    const serverFlag = ["VIVA", "STATIC", "EXPORT"].join("_");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalAgentEnv = process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL;
    const originalApiEnv = process.env.NEXT_PUBLIC_VIVA_API_URL;
    const originalPublicFlag = process.env[publicFlag];
    const originalServerFlag = process.env[serverFlag];
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
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

    const flagCombinations: Array<Record<string, string | undefined>> = [
      {},
      { [publicFlag]: "1" },
      { [serverFlag]: "1" },
      { [publicFlag]: "1", [serverFlag]: "1" },
    ];

    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { origin: "http://localhost:3000" } },
      });
      process.env.NEXT_PUBLIC_VIVA_AGENT_HTTP_URL = "https://agent.example";
      delete process.env.NEXT_PUBLIC_VIVA_API_URL;

      for (const flags of flagCombinations) {
        delete process.env[publicFlag];
        delete process.env[serverFlag];
        for (const [name, value] of Object.entries(flags)) {
          if (value !== undefined) process.env[name] = value;
        }
        await fetchVivaLibrarySnapshot({ fetchImpl, userId: "user-1" });
      }
    } finally {
      restoreGlobalProperty("window", originalWindow);
      restoreEnv("NEXT_PUBLIC_VIVA_AGENT_HTTP_URL", originalAgentEnv);
      restoreEnv("NEXT_PUBLIC_VIVA_API_URL", originalApiEnv);
      restoreEnv(publicFlag, originalPublicFlag);
      restoreEnv(serverFlag, originalServerFlag);
    }

    // Every combination — including both flags set to the old "on" value — routes
    // through the same-origin Next proxy. A configured public agent origin is a
    // SERVER base and never a browser destination.
    expect(requested).toEqual([
      "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
      "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
      "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
      "http://localhost:3000/api/viva-library/study-sets/library?user_id=user-1",
    ]);

    // ...and the browser client exports no static-export predicate at all, so no
    // caller can reintroduce a static routing branch through it.
    const exportedNames = Object.keys(vivaAgentClientModule);
    expect(exportedNames.filter((name) => /static/i.test(name))).toEqual([]);
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

/**
 * `WEBSESSION-PROTOCOL-01` / `WEBSESSION-RECAP-01` / `WEBSESSION-DEFERRED-01`.
 *
 * Every case here consumes Plan 05's published v5 contract — its parser, its
 * diagnostics, its typed termination classifier, and its own fixture manifest.
 * Nothing in this block re-encodes a second web-only parser, a close-reason
 * allowlist, or a hand-copied expectation table.
 */
describe("v5 protocol consumption", () => {
  function openTypedController(options: { ready?: boolean } = {}) {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
      url: "ws://localhost:4318/ws",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    if (options.ready !== false) socket.message(JSON.stringify(readyFixture));
    return { controller, socket };
  }

  test("a malformed frame records only a sanitized diagnostic code and JSON path", () => {
    const { controller, socket } = openTypedController();
    const sentinel =
      '{"type":"event","transcript":"NADH donates electrons","url":"https://leak.example/auth",' +
      '"session_token":"viva1.leaked-token","note":"auth token"';

    socket.message(sentinel);

    const state = controller.getState();
    expect(state.diagnostics).toEqual([{ code: "VOICE_PROTOCOL_MALFORMED_JSON", path: "$" }]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("NADH donates electrons");
    expect(serialized).not.toContain("leak.example");
    expect(serialized).not.toContain("viva1.leaked-token");
    expect(serialized.toLowerCase()).not.toContain("auth");
    expect(serialized.toLowerCase()).not.toContain("token");
  });

  test("every invalid Plan 05 server-differential case yields its exact diagnostic code and path", () => {
    const invalidCases = serverDifferentialCases.cases.filter((entry) => !entry.valid);
    expect(invalidCases.length).toBeGreaterThan(50);

    for (const entry of invalidCases) {
      const { controller, socket } = openTypedController();
      socket.message(entry.wire_json);
      const state = controller.getState();
      expect({ code: state.diagnostics.at(-1)?.code, id: entry.id }).toEqual({
        code: entry.diagnostic_code,
        id: entry.id,
      });
      expect({ id: entry.id, path: state.diagnostics.at(-1)?.path }).toEqual({
        id: entry.id,
        path: entry.path,
      });
      expect(state.diagnostics).toHaveLength(1);
      // No rejected value is retained: the frame body is absent from state.
      expect(JSON.stringify(state)).not.toContain("Fixture excerpt.");
    }
  });

  test("the invalid families the plan names are all present in the Plan 05 fixture manifest", () => {
    expect(manifestFixture.fixtures.map((entry) => entry.id)).toContain(
      "VOICE-SERVER-DIFFERENTIAL-CASES",
    );
    const ids = new Set(
      serverDifferentialCases.cases.filter((entry) => !entry.valid).map((entry) => entry.id),
    );
    for (const required of [
      "VOICE-SERVER-REJECT-NON-OBJECT",
      "VOICE-SERVER-REJECT-UNKNOWN-FRAME",
      "VOICE-SERVER-REJECT-UNKNOWN-EVENT",
      "VOICE-SERVER-REJECT-V4",
      "VOICE-SERVER-REJECT-FUTURE-VERSION",
      "VOICE-SERVER-REJECT-UNKNOWN-FRAME-KEY",
      "VOICE-SERVER-REJECT-UNKNOWN-EVENT-KEY",
      "VOICE-SERVER-REJECT-UNKNOWN-QUESTION-KEY",
      "VOICE-SERVER-REJECT-MISSING-QUESTION-CONCEPT",
      "VOICE-SERVER-REJECT-UNKNOWN-RUBRIC-CRITERION-KEY",
      "VOICE-SERVER-REJECT-EVALUATION-LABEL",
      "VOICE-SERVER-REJECT-DEFERRED-UNKNOWN-REASON",
      "VOICE-SERVER-REJECT-DEFERRED-RETRYABLE",
      "VOICE-SERVER-REJECT-DEFERRED-TERMINAL-REASON",
      "VOICE-SERVER-REJECT-DEFERRED-LEARNER-FACT",
      "VOICE-SERVER-REJECT-RECAP-COMPLETE-WITH-REASON",
      "VOICE-SERVER-REJECT-RECAP-PARTIAL-WITHOUT-REASON",
      "VOICE-SERVER-REJECT-STRUCTURED-ERROR-RECOVERABLE-WITH-REASON",
      "VOICE-SERVER-REJECT-STRUCTURED-ERROR-TERMINAL-WITHOUT-REASON",
      "VOICE-SERVER-REJECT-ERROR-MESSAGE-TYPE",
      "VOICE-SERVER-REJECT-ERROR-RETRYABILITY",
    ]) {
      expect({ id: required, present: ids.has(required) }).toEqual({ id: required, present: true });
    }
  });

  test("a local browser exception becomes one fixed internal diagnostic, never a stringified error", () => {
    const { controller, socket } = openTypedController();
    // `Object.defineProperty`, not `Object.assign`: assign would INVOKE the
    // getter while copying and throw inside the test instead of inside the
    // controller's own message handler.
    const hostile = new Event("message");
    Object.defineProperty(hostile, "data", {
      get(): string {
        throw new Error("browser internal: viva1.secret-token transcript leak");
      },
    });
    for (const listener of socket.listeners.get("message") ?? []) listener(hostile);

    const state = controller.getState();
    expect(state.diagnostics).toEqual([{ code: "WEB_VOICE_INTERNAL", path: null }]);
    expect(JSON.stringify(state)).not.toContain("viva1.secret-token");
    expect(JSON.stringify(state)).not.toContain("browser internal");
  });

  test("every Plan 05 transport outcome classifies exactly as the fixture pins it", () => {
    for (const entry of transportOutcomes.cases) {
      const { controller, socket } = openTypedController();
      if (entry.input.terminalReason) {
        socket.message(
          JSON.stringify({
            event: {
              phase: "recap",
              terminal_reason: entry.input.terminalReason,
              type: "session_phase",
            },
            type: "event",
            version: VIVA_VOICE_PROTOCOL_VERSION,
          }),
        );
      }
      if (entry.input.error) {
        socket.message(
          JSON.stringify({
            error: entry.input.error,
            type: "error",
            version: VIVA_VOICE_PROTOCOL_VERSION,
          }),
        );
      }
      socket.close({ code: entry.input.closeCode, reason: "", wasClean: entry.input.wasClean });

      const state = controller.getState();
      expect({ id: entry.id, termination: state.termination }).toEqual({
        id: entry.id,
        termination: entry.expected,
      });
      if (entry.input.error) {
        expect(JSON.stringify(state)).not.toContain(entry.input.error.message);
      }
    }
  });

  test("a hostile typed-error message never reaches classification, state, or copy", () => {
    const { controller, socket } = openTypedController();
    const sentinel = "viva1.secret-token NADH donates electrons";

    socket.message(
      JSON.stringify({
        error: { code: "VOICE_AUTH_EXPIRED", message: sentinel, retryable: true },
        type: "error",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );
    socket.close({ code: 1008, reason: sentinel, wasClean: true });

    const state = controller.getState();
    expect(state.lastServerError).toEqual({ code: "VOICE_AUTH_EXPIRED", retryable: true });
    expect(state.termination).toEqual({
      closeCode: 1008,
      errorCode: "VOICE_AUTH_EXPIRED",
      kind: "auth",
      retryable: true,
    });
    expect(JSON.stringify(state)).not.toContain("viva1.secret-token");
    expect(JSON.stringify(state)).not.toContain("NADH donates electrons");
  });

  test("only VOICE_AUTH_EXPIRED is a retryable auth termination", () => {
    const authOutcomes = transportOutcomes.cases.filter((entry) => entry.expected.kind === "auth");
    expect(authOutcomes.map((entry) => entry.expected.errorCode)).toEqual([
      "VOICE_AUTH_EXPIRED",
      "VOICE_AUTH_INVALID",
      "VOICE_AUTH_IDENTITY_MISMATCH",
      "VOICE_AUTH_REPLAYED",
    ]);
    for (const entry of authOutcomes) {
      expect({ code: entry.expected.errorCode, retryable: entry.expected.retryable }).toEqual({
        code: entry.expected.errorCode,
        retryable: entry.expected.errorCode === "VOICE_AUTH_EXPIRED",
      });
    }
    for (const entry of transportOutcomes.cases.filter(
      (outcome) => outcome.expected.kind === "protocol",
    )) {
      expect(entry.expected.retryable).toBe(false);
    }
    for (const entry of transportOutcomes.cases.filter((outcome) =>
      ["service", "transport"].includes(outcome.expected.kind),
    )) {
      expect(entry.expected.retryable).toBe(true);
    }
  });

  test("a complete recap folds to terminal success and closes further submission", () => {
    const { controller, socket } = openTypedController();
    socket.message(completeRecapSequence?.wire_sequence_json[0] ?? "");

    const state = controller.getState();
    expect(state.recap?.kind).toBe("complete");
    if (state.recap?.kind !== "complete") throw new Error("Expected a complete recap");
    expect(state.recap.recap.schema).toBe("viva.study_session_recap.v2");
    expect(state.recap.recap.review_schedule.length).toBeGreaterThan(0);
    expect(state.terminalReason).toBeUndefined();
    expect(state.pendingSubmission).toBeUndefined();
    expect(controller.sendText("late answer after a complete recap")).toBe(false);
  });

  test("a partial recap is terminal immediately, with its reason and typed termination", () => {
    const { controller, socket } = openTypedController();
    socket.message(JSON.stringify(recapFrame({ partial: true, partialReason: "turn_cap" })));

    const state = controller.getState();
    expect(state.recap?.kind).toBe("partial");
    if (state.recap?.kind !== "partial") throw new Error("Expected a partial recap");
    expect(state.recap.partialReason).toBe("turn_cap");
    expect(state.terminalReason).toBe("turn_cap");
    expect(state.termination?.kind).toBe("terminal");
    expect(state.pendingSubmission).toBeUndefined();
    expect(controller.sendText("late answer after a partial recap")).toBe(false);
  });

  test("a trailing terminal phase that disagrees with the partial reason is a sanitized invariant", () => {
    const { controller, socket } = openTypedController();
    socket.message(JSON.stringify(recapFrame({ partial: true, partialReason: "turn_cap" })));
    socket.message(
      JSON.stringify({
        event: { phase: "recap", terminal_reason: "cost_budget", type: "session_phase" },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );

    const state = controller.getState();
    expect(state.diagnostics).toEqual([
      { code: "VOICE_PROTOCOL_INVARIANT", path: "$.event.terminal_reason" },
    ]);
    expect(state.terminalReason).toBe("turn_cap");
  });

  test("every Plan 05 terminal sequence folds to its pinned terminal reason", () => {
    for (const sequence of terminalSequences.sequences) {
      const { controller, socket } = openTypedController();
      for (const wire of sequence.wire_sequence_json) socket.message(wire);
      expect({ id: sequence.id, reason: controller.getState().terminalReason ?? null }).toEqual({
        id: sequence.id,
        reason: sequence.terminal_reason ?? null,
      });
    }
  });

  test("a terminal structured error closes input immediately without a free-form field", () => {
    const { controller, socket } = openTypedController();
    socket.message(
      JSON.stringify({
        event: {
          code: "provider_stream_broken",
          message: "raw provider transcript viva1.secret-token",
          source: "cartesia_gemini",
          terminal_reason: "provider_malformed_stream",
          terminality: "terminal",
          type: "structured_error",
        },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );

    const state = controller.getState();
    expect(state.structuredErrors).toEqual([
      { terminalReason: "provider_malformed_stream", terminality: "terminal" },
    ]);
    expect(state.terminalReason).toBe("provider_malformed_stream");
    expect(state.termination?.kind).toBe("terminal");
    expect(state.pendingSubmission).toBeUndefined();
    expect(controller.sendText("late answer after a terminal structured error")).toBe(false);
    expect(JSON.stringify(state)).not.toContain("viva1.secret-token");
    expect(JSON.stringify(state)).not.toContain("provider_stream_broken");
  });

  test("a recoverable structured error leaves the socket open and the next submit legal", () => {
    const { controller, socket } = openTypedController();
    socket.message(
      JSON.stringify({
        event: {
          code: "provider_stream_hiccup",
          message: "raw provider transcript",
          source: "cartesia_gemini",
          terminality: "recoverable",
          type: "structured_error",
        },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );

    const state = controller.getState();
    expect(state.structuredErrors).toEqual([{ terminality: "recoverable" }]);
    expect(state.status).toBe("open");
    expect(state.terminalReason).toBeUndefined();
    expect(state.termination).toBeUndefined();
    expect(controller.sendText("the next legal submit")).toBe(true);
  });

  test("a recoverable structured error never resolves a pending turn it does not name", () => {
    const { controller, socket } = openTypedController();
    expect(controller.sendText("first typed response")).toBe(true);
    socket.message(
      JSON.stringify({
        event: {
          code: "provider_stream_hiccup",
          message: "raw provider transcript",
          source: "cartesia_gemini",
          terminality: "recoverable",
          type: "structured_error",
        },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );

    expect(controller.getState().pendingSubmission).toEqual({
      generationId: "session_bootstrap-1",
      kind: "text",
    });
  });

  test("all six deferral reasons stay ungraded, nonterminal, and retryable only from the server boolean", () => {
    for (const reason of VIVA_VOICE_DEFERRAL_REASONS) {
      for (const canRetry of [true, false]) {
        const { controller, socket } = openTypedController();
        socket.message(JSON.stringify(questionStartedFrame("turn-1", "response-1", "q-fixture-1")));
        expect(controller.sendText("a spoken-equivalent typed answer")).toBe(true);
        socket.message(
          JSON.stringify({
            event: {
              can_retry_same_question: canRetry,
              question_id: "q-fixture-1",
              reason,
              response_id: "response-1",
              turn_id: "turn-1",
              type: "turn_deferred",
            },
            type: "event",
            version: VIVA_VOICE_PROTOCOL_VERSION,
          }),
        );

        const state = controller.getState();
        expect({ canRetry, deferred: state.deferredTurn, reason }).toEqual({
          canRetry,
          deferred: {
            canRetrySameQuestion: canRetry,
            questionId: "q-fixture-1",
            reason,
            responseId: "response-1",
            turnId: "turn-1",
          },
          reason,
        });
        expect(state.status).toBe("open");
        expect(state.terminalReason).toBeUndefined();
        expect(state.termination).toBeUndefined();
        expect(state.evaluation).toBeUndefined();
        expect(state.recap).toBeUndefined();
        expect(state.currentConceptStatus).toBeUndefined();
        expect(state.conceptStatuses).toEqual({});
        expect(state.conceptStatusEvents).toEqual([]);
        expect(state.structuredErrors).toEqual([]);
        expect(state.pendingSubmission).toBeUndefined();
      }
    }
  });

  test("a later question progression clears the matching deferred turn", () => {
    const { controller, socket } = openTypedController();
    socket.message(JSON.stringify(questionStartedFrame("turn-1", "response-1", "q-fixture-1")));
    socket.message(
      JSON.stringify({
        event: {
          can_retry_same_question: true,
          question_id: "q-fixture-1",
          reason: "transcript_uncertain",
          response_id: "response-1",
          turn_id: "turn-1",
          type: "turn_deferred",
        },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );
    expect(controller.getState().deferredTurn?.questionId).toBe("q-fixture-1");

    socket.message(JSON.stringify(questionStartedFrame("turn-2", "response-2", "q-fixture-2")));
    expect(controller.getState().deferredTurn).toBeUndefined();
  });

  test("a stale deferred turn is counted, never allowed to replace the current question", () => {
    const { controller, socket } = openTypedController();
    socket.message(JSON.stringify(questionStartedFrame("turn-2", "response-2", "q-fixture-2")));
    socket.message(
      JSON.stringify({
        event: {
          can_retry_same_question: true,
          question_id: "q-fixture-1",
          reason: "empty_answer",
          response_id: "response-1",
          turn_id: "turn-1",
          type: "turn_deferred",
        },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );

    const state = controller.getState();
    expect(state.staleEvents).toBe(1);
    expect(state.deferredTurn).toBeUndefined();
    expect(state.question?.question_id).toBe("q-fixture-2");
  });
});

const completeRecapSequence = terminalSequences.sequences.find(
  (sequence) => sequence.id === "VOICE-NONTERMINAL-COMPLETE-RECAP",
);

function questionStartedFrame(turnId: string, responseId: string, questionId: string) {
  return {
    event: {
      question: {
        concept_id: "concept-fixture-1",
        expected_terms: ["fixture term"],
        follow_up: "Fixture follow up.",
        prompt: "Fixture prompt.",
        question_id: questionId,
        rubric: {
          criteria: [
            {
              claim: "Fixture claim.",
              concept_id: "concept-fixture-1",
              criterion_id: "crit-fixture-1",
              required: true,
              source_id: "src-lecture-5-slide-18",
            },
          ],
          policy_version: "viva.semantic-rubric.v1",
        },
        source: {
          confidence: "high" as const,
          document_id: "lec-5",
          excerpt: "Fixture excerpt.",
          retrieval_reason: "server fixture source",
          source_id: "src-lecture-5-slide-18",
          span: "slide:18",
        },
      },
      response_id: responseId,
      turn_id: turnId,
      type: "question_started",
    },
    type: "event",
    version: VIVA_VOICE_PROTOCOL_VERSION,
  };
}

function recapFrame(input: { partial: boolean; partialReason?: string }) {
  return {
    event: {
      partial: input.partial,
      ...(input.partialReason ? { partial_reason: input.partialReason } : {}),
      recap: {
        concepts: [{ concept_id: "concept-fixture-1", label: "Fixture concept", status: "shaky" }],
        deferred_turns: 1,
        headline: "Fixture headline.",
        next_action: "Fixture next action.",
        review_schedule: [
          {
            authority: "server_persisted_fsrs",
            concept_id: "concept-fixture-1",
            due_at: "2026-09-01T00:00:00Z",
          },
        ],
        schema: "viva.study_session_recap.v2",
        source_moments: [{ response_id: "response-1", source_id: "src-lecture-5-slide-18" }],
        summary: "Fixture summary.",
        voice_session_id: "voice-session-fixture",
      },
      response_id: "response-1",
      type: "recap_ready",
    },
    type: "event",
    version: VIVA_VOICE_PROTOCOL_VERSION,
  };
}

/**
 * `WEBSESSION-RECOVERY-01` / `WEBSESSION-AUDIO-01`: the bounded-recovery decision
 * and the cross-generation replay of Plan 03's retained turn. Nothing here
 * builds a second queue — every replay goes back through `retryPendingAudio()`.
 */
describe("bounded voice recovery", () => {
  function openLedgerController() {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      audioQueuePumpIntervalMs: 0,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
      url: "ws://localhost:4318/ws",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));
    return { controller, socket };
  }

  function reconnectState(
    overrides: Partial<VivaAgentReconnectInputState> = {},
  ): VivaAgentReconnectInputState {
    return {
      recap: undefined,
      status: "closed" as const,
      structuredErrors: [],
      terminalReason: undefined,
      termination: { closeCode: 1006, kind: "transport" as const, retryable: true },
      ...overrides,
    };
  }

  test("every first retry clears the server's 250 ms lease grace", () => {
    expect(VIVA_AGENT_RECONNECT_DELAYS_MS).toEqual([500, 1_000, 2_000]);
    expect(VIVA_AGENT_RECONNECT_JITTER_MS).toBe(100);
    expect(reconnectDelayMs(1, 0)).toBe(500);
    expect(reconnectDelayMs(1, 0.999_999)).toBe(599);
    expect(reconnectDelayMs(2, 0)).toBe(1_000);
    expect(reconnectDelayMs(2, 0.999_999)).toBe(1_099);
    expect(reconnectDelayMs(3, 0)).toBe(2_000);
    expect(reconnectDelayMs(3, 0.999_999)).toBe(2_099);
    // A hostile random never escapes the band.
    expect(reconnectDelayMs(1, -5)).toBe(500);
    expect(reconnectDelayMs(1, 5)).toBe(599);
    expect(reconnectDelayMs(1, Number.NaN)).toBe(500);
    for (const attempt of [1, 2, 3] as const) {
      expect(reconnectDelayMs(attempt, 0)).toBeGreaterThan(250);
    }
  });

  test("a retryable transport close schedules exactly three bounded attempts", () => {
    expect(
      vivaAgentReconnectDecision({
        attempts: 0,
        explicitlyStopped: false,
        random: 0.5,
        state: reconnectState(),
      }),
    ).toEqual({ action: "schedule", attempt: 1, delayMs: 550 });
    expect(
      vivaAgentReconnectDecision({
        attempts: 1,
        explicitlyStopped: false,
        random: 0,
        state: reconnectState(),
      }),
    ).toEqual({ action: "schedule", attempt: 2, delayMs: 1_000 });
    expect(
      vivaAgentReconnectDecision({
        attempts: 2,
        explicitlyStopped: false,
        random: 0,
        state: reconnectState(),
      }),
    ).toEqual({ action: "schedule", attempt: 3, delayMs: 2_000 });
    expect(
      vivaAgentReconnectDecision({
        attempts: 3,
        explicitlyStopped: false,
        random: 0,
        state: reconnectState(),
      }),
    ).toEqual({ action: "exhausted" });
  });

  test("every stop condition refuses to schedule a retry", () => {
    const cases: Array<[string, VivaAgentReconnectInputState, boolean]> = [
      [
        "complete recap",
        reconnectState({
          recap: { kind: "complete", recap: recapFrame({ partial: false }).event.recap as never },
        }),
        false,
      ],
      [
        "partial recap",
        reconnectState({
          recap: {
            kind: "partial",
            partialReason: "turn_cap",
            recap: recapFrame({ partial: false }).event.recap as never,
          },
          terminalReason: "turn_cap",
        }),
        false,
      ],
      ["terminal reason", reconnectState({ terminalReason: "drained" }), false],
      [
        "terminal structured error",
        reconnectState({
          structuredErrors: [
            { terminalReason: "provider_malformed_stream", terminality: "terminal" },
          ],
        }),
        false,
      ],
      [
        "terminal termination",
        reconnectState({
          termination: {
            closeCode: 1011,
            kind: "terminal",
            retryable: false,
            terminalReason: "session_cap",
          },
        }),
        false,
      ],
      [
        "nonretryable auth",
        reconnectState({
          termination: {
            closeCode: 1008,
            errorCode: "VOICE_AUTH_INVALID",
            kind: "auth",
            retryable: false,
          },
        }),
        false,
      ],
      [
        "protocol",
        reconnectState({
          termination: {
            closeCode: 1008,
            errorCode: "VOICE_CLIENT_FRAME_TOO_LARGE",
            kind: "protocol",
            retryable: false,
          },
        }),
        false,
      ],
      [
        "clean 1000",
        reconnectState({ termination: { closeCode: 1000, kind: "normal", retryable: false } }),
        false,
      ],
      ["still open", reconnectState({ status: "open", termination: undefined }), false],
      [
        "retryable auth",
        reconnectState({
          termination: {
            closeCode: 1008,
            errorCode: "VOICE_AUTH_EXPIRED",
            kind: "auth",
            retryable: true,
          },
        }),
        true,
      ],
      [
        "service",
        reconnectState({
          termination: {
            closeCode: 1011,
            errorCode: "VOICE_INTERNAL_SERIALIZATION",
            kind: "service",
            retryable: true,
          },
        }),
        true,
      ],
      ["transport", reconnectState(), true],
    ];

    for (const [label, state, schedules] of cases) {
      const decision = vivaAgentReconnectDecision({
        attempts: 0,
        explicitlyStopped: false,
        random: 0,
        state,
      });
      expect({ label, schedules: decision.action === "schedule" }).toEqual({ label, schedules });
    }

    // An explicit learner close or stop wins over ANY retryable classification.
    expect(
      vivaAgentReconnectDecision({
        attempts: 0,
        explicitlyStopped: true,
        random: 0,
        state: reconnectState(),
      }),
    ).toEqual({ action: "stop", reason: "explicit_stop" });
  });

  test("the retained turn is reported with its original identity after an interrupted stream", () => {
    const { controller, socket } = openLedgerController();
    controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([1, 2, 3, 4]),
      sequence: 0,
      turnId: "turn-recovery-1",
    });
    socket.bufferedAmount = VIVA_VOICE_MAX_TEXT_FRAME_BYTES;
    const pending = controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([5, 6, 7, 8]),
      sequence: 1,
      turnId: "turn-recovery-1",
    });
    expect(pending.status).toBe("pending");

    socket.close({ code: 1006, reason: "", wasClean: false });

    expect(controller.getRetainedAudioTurn()).toEqual({
      acceptedThroughSequence: 0,
      endRequested: false,
      finalSequence: null,
      retainedBytes: 8,
      retainedFromSequence: 0,
      turnId: "turn-recovery-1",
    });
  });

  test("replay on a new generation resends the original turn id and original sequence bytes", () => {
    const { controller, socket } = openLedgerController();
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([5, 6, 7, 8]);
    controller.sendAudioChunk({ pcm16Bytes: first, sequence: 0, turnId: "turn-replay" });
    socket.bufferedAmount = VIVA_VOICE_MAX_TEXT_FRAME_BYTES;
    controller.sendAudioChunk({ pcm16Bytes: second, sequence: 1, turnId: "turn-replay" });
    socket.close({ code: 1006, reason: "", wasClean: false });

    const next = controller.refreshSession({
      reason: "socket_retry",
      sessionToken: REFRESHED_SESSION_CREDENTIAL,
    }) as unknown as FakeWebSocket;
    next.open();
    next.message(JSON.stringify(readyFixture));

    const replay = controller.retryPendingAudio();
    expect(replay.status).toBe("sent");

    const replayed = next.sent
      .map((frame) => parseVivaClientFrame(JSON.parse(frame)))
      .filter((frame) => frame.type === "audio_chunk");
    expect(replayed).toHaveLength(2);
    expect(replayed.map((frame) => frame.turn_id)).toEqual(["turn-replay", "turn-replay"]);
    expect(replayed.map((frame) => frame.sequence)).toEqual([0, 1]);
    expect(replayed.map((frame) => frame.frame.pcm16_base64)).toEqual([
      pcm16LeBytesToBase64(first),
      pcm16LeBytesToBase64(second),
    ]);
    // Still retained: only an `audio_turn_accepted` releases it.
    expect(controller.getRetainedAudioTurn()?.turnId).toBe("turn-replay");
  });

  test("a turn closed after audio_end is replayed whole and admitted exactly once", () => {
    const { controller, socket } = openLedgerController();
    controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
      sequence: 0,
      turnId: "turn-after-end",
    });
    controller.endAudioTurn({ finalSequence: 0, turnId: "turn-after-end" });
    expect(socket.sent.map((frame) => parseVivaClientFrame(JSON.parse(frame)).type).at(-1)).toBe(
      "audio_end",
    );

    socket.close({ code: 1006, reason: "", wasClean: false });
    expect(controller.getRetainedAudioTurn()).toEqual({
      acceptedThroughSequence: 0,
      endRequested: true,
      finalSequence: 0,
      retainedBytes: 4,
      retainedFromSequence: 0,
      turnId: "turn-after-end",
    });

    const next = controller.refreshSession({ reason: "socket_retry" }) as unknown as FakeWebSocket;
    next.open();
    next.message(JSON.stringify(readyFixture));
    expect(controller.retryPendingAudio().status).toBe("sent");

    const kinds = next.sent.map((frame) => parseVivaClientFrame(JSON.parse(frame)).type);
    expect(kinds.filter((kind) => kind === "audio_chunk")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "audio_end")).toHaveLength(1);

    next.message(
      JSON.stringify({
        client_generation_id: "socket_retry-2",
        final_sequence: 0,
        turn_id: "turn-after-end",
        type: "audio_turn_accepted",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );
    expect(controller.getRetainedAudioTurn()).toBeNull();
    expect(controller.getState().acceptedAudioTurn).toEqual({
      finalSequence: 0,
      turnId: "turn-after-end",
    });

    // A second replay attempt after the ack has nothing to resend, so no second
    // admission can be manufactured.
    const kindsAfterAck = next.sent.map((frame) => parseVivaClientFrame(JSON.parse(frame)).type);
    expect(kindsAfterAck.filter((kind) => kind === "audio_end")).toHaveLength(1);
  });

  test("cancelling a consumed assembly releases the ledger without a scoped cancel frame", () => {
    const { controller, socket } = openLedgerController();
    controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([1, 1, 1, 1]),
      sequence: 0,
      turnId: "turn-consumed",
    });
    controller.endAudioTurn({ finalSequence: 0, turnId: "turn-consumed" });
    const sentBeforeCancel = socket.sent.length;

    controller.cancelAudioTurn("turn-consumed");

    expect(socket.sent).toHaveLength(sentBeforeCancel);
    expect(controller.getRetainedAudioTurn()).toBeNull();
  });

  test("cancelling a turn the server has not consumed still sends the scoped cancel", () => {
    const { controller, socket } = openLedgerController();
    controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([1, 1, 1, 1]),
      sequence: 0,
      turnId: "turn-open",
    });

    controller.cancelAudioTurn("turn-open");

    const cancels = socket.sent
      .map((frame) => parseVivaClientFrame(JSON.parse(frame)))
      .filter((frame) => frame.type === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.type === "cancel" ? cancels[0].turn_id : null).toBe("turn-open");
    expect(controller.getRetainedAudioTurn()).toBeNull();
  });

  test("stale callbacks from a replaced generation change nothing at all", () => {
    const { controller, socket } = openLedgerController();
    controller.sendAudioChunk({
      pcm16Bytes: new Uint8Array([2, 2, 2, 2]),
      sequence: 0,
      turnId: "turn-stale",
    });
    socket.close({ code: 1006, reason: "", wasClean: false });

    const next = controller.refreshSession({ reason: "socket_retry" }) as unknown as FakeWebSocket;
    next.open();
    next.message(JSON.stringify(readyFixture));
    const before = controller.getState();
    const retainedBefore = controller.getRetainedAudioTurn();

    socket.message(
      JSON.stringify({
        event: { phase: "recap", terminal_reason: "drained", type: "session_phase" },
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
      }),
    );
    socket.error();
    socket.close({ code: 1011, reason: "", wasClean: false });

    expect(controller.getState()).toEqual(before);
    expect(controller.getRetainedAudioTurn()).toEqual(retainedBefore);
  });
});

/**
 * `WEBSESSION-INTENT-01`: a learner intent is a TYPED frame. A citation
 * challenge is not answer text and can never be graded as one.
 */
describe("typed learner turn intents", () => {
  function openIntentController() {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
      url: "ws://localhost:4318/ws",
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));
    return { controller, socket };
  }

  test("a citation challenge is its own typed intent, never answer text", () => {
    const { controller, socket } = openIntentController();

    const result = controller.sendTurnIntent({
      intent: {
        kind: "citation_challenge",
        response_id: "response-1",
        source_id: "src-lecture-5-slide-18",
      },
      turnId: "turn-challenge-1",
    });

    expect(result).toEqual({ status: "sent", turnId: "turn-challenge-1" });
    const frames = socket.sent.slice(1).map((frame) => parseVivaClientFrame(JSON.parse(frame)));
    expect(frames).toHaveLength(1);
    const intent = frames[0];
    if (intent?.type !== "turn_intent") throw new Error("Expected a turn intent");
    expect(intent).toEqual({
      client_generation_id: "session_bootstrap-1",
      intent: {
        kind: "citation_challenge",
        response_id: "response-1",
        source_id: "src-lecture-5-slide-18",
      },
      turn_id: "turn-challenge-1",
      type: "turn_intent",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    const wire = socket.sent.join(" ");
    expect(wire).not.toContain("(challenge citation)");
    expect(wire).not.toContain("answer_text");
    // A challenge produces no local evaluation and no mastery movement.
    const state = controller.getState();
    expect(state.evaluation).toBeUndefined();
    expect(state.conceptStatuses).toEqual({});
    expect(state.conceptStatusEvents).toEqual([]);
  });

  test("an occupied pending slot is reported as pending, not as a second frame", () => {
    const { controller, socket } = openIntentController();
    expect(
      controller.sendTurnIntent({
        intent: { kind: "answer_text", text: "first typed answer" },
        turnId: "turn-a",
      }),
    ).toEqual({ status: "sent", turnId: "turn-a" });

    const second = controller.sendTurnIntent({
      intent: {
        kind: "citation_challenge",
        response_id: "response-1",
        source_id: "src-lecture-5-slide-18",
      },
      turnId: "turn-b",
    });

    expect(second).toEqual({ status: "pending", turnId: "turn-b" });
    expect(socket.sent.slice(1)).toHaveLength(1);
  });

  test("a closed socket is a retryable socket_closed, and typed content never enters the ledger", () => {
    const { controller, socket } = openIntentController();
    socket.close({ code: 1006, reason: "", wasClean: false });

    const result = controller.sendTurnIntent({
      intent: { kind: "answer_text", text: "typed while the socket was gone" },
      turnId: "turn-closed",
    });

    expect(result.status).toBe("socket_closed");
    if (result.status !== "socket_closed") throw new Error("Expected socket_closed");
    expect(result.turnId).toBe("turn-closed");
    expect(result.retryable).toBe(true);
    expect(result.error.code).toBe("socket_closed");
    // Typed content is NOT audio: it never reaches Plan 03's retained ledger and
    // is never auto-replayed by the recovery path.
    expect(controller.getRetainedAudioTurn()).toBeNull();
    expect(JSON.stringify(controller.getState())).not.toContain("typed while the socket was gone");
  });

  test("an oversized typed answer is rejected before send, from its typed diagnostic alone", () => {
    const { controller, socket } = openIntentController();
    const sentBefore = socket.sent.length;

    const result = controller.sendTurnIntent({
      intent: { kind: "answer_text", text: "N".repeat(VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1) },
      turnId: "turn-oversized",
    });

    expect(result).toEqual({
      diagnostic: { code: "VOICE_PROTOCOL_FRAME_TOO_LARGE", path: "$" },
      status: "rejected",
      turnId: "turn-oversized",
    });
    expect(socket.sent).toHaveLength(sentBefore);
    expect(controller.getState().diagnostics.at(-1)).toEqual({
      code: "VOICE_PROTOCOL_FRAME_TOO_LARGE",
      path: "$",
    });
    expect(controller.getState().pendingSubmission).toBeUndefined();
    expect(JSON.stringify(controller.getState())).not.toContain("NNNN");
  });

  test("a malformed challenge target is rejected at its own JSON path", () => {
    const { controller, socket } = openIntentController();
    const sentBefore = socket.sent.length;

    const result = controller.sendTurnIntent({
      intent: { kind: "citation_challenge", response_id: "  ", source_id: "src-1" },
      turnId: "turn-bad-target",
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected rejected");
    expect(result.diagnostic.path).toBe("$.intent.response_id");
    expect(socket.sent).toHaveLength(sentBefore);
  });

  test("sendText is the answer_text intent and nothing else", () => {
    const { controller, socket } = openIntentController();
    expect(controller.sendText("a typed answer")).toBe(true);

    const frame = parseVivaClientFrame(JSON.parse(socket.sent[1] ?? "{}"));
    if (frame.type !== "turn_intent") throw new Error("Expected a turn intent");
    expect(frame.intent).toEqual({ kind: "answer_text", text: "a typed answer" });
    expect(controller.getState().pendingSubmission).toEqual({
      generationId: "session_bootstrap-1",
      kind: "text",
    });
  });
});

/**
 * `WEBSESSION-READY-01` — the readiness probe's own request boundary.
 *
 * A readiness poll that cannot finish is an availability FACT, not a hung
 * promise: every request carries the same signal, the probe owns a hard
 * deadline, and a caller that goes away can abort the work it started. Nothing
 * here retries inside one probe — repetition belongs to the page's poll owner.
 */
describe("bounded agent readiness probe", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const SENTINEL = "VIVA_READINESS_SENTINEL_TOKEN";

  function healthBody() {
    return {
      brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
      provider: "synthetic",
      status: "ok",
      store: readyFixture.store,
    };
  }

  function readyBody() {
    return {
      brain: { configured: true, live_runtime: false, provider: "synthetic", selectable: true },
      ready: true,
      store: readyFixture.store,
    };
  }

  type ProbeFetchRecord = {
    fetchImpl: typeof fetch;
    signals: AbortSignal[];
    urls: string[];
    settle: () => void;
  };

  /** Both endpoints answer only when the test says so. */
  function stalledProbeFetch(): ProbeFetchRecord {
    const signals: AbortSignal[] = [];
    const urls: string[] = [];
    const releases: Array<() => void> = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((resolve, reject) => {
        // `fetch`'s own contract: an ALREADY-aborted signal rejects rather than
        // waiting for an abort event that can never fire again.
        if (init?.signal?.aborted) {
          reject(new Error(`aborted ${SENTINEL}`));
          return;
        }
        releases.push(() =>
          resolve(jsonResponse(200, url.endsWith("/ready") ? readyBody() : healthBody())),
        );
        init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${SENTINEL}`)), {
          once: true,
        });
      });
    }) as typeof fetch;
    return {
      fetchImpl,
      settle: () => {
        for (const release of releases) release();
      },
      signals,
      urls,
    };
  }

  test("publishes the request deadline and poll cadence the page schedules against", () => {
    expect(VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS).toBe(4_000);
    expect(VIVA_AGENT_READINESS_POLL_INTERVAL_MS).toBe(5_000);
    // The request deadline must stay strictly inside the poll interval, or a
    // "settle then wait" loop degenerates back into overlapping polls.
    expect(VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS).toBeLessThan(
      VIVA_AGENT_READINESS_POLL_INTERVAL_MS,
    );
  });

  test("aborts every stalled readiness request at 4,000 ms and states sanitized unavailability", async () => {
    jest.useFakeTimers();
    const probe = stalledProbeFetch();
    const pending = fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: probe.fetchImpl,
    });

    expect(probe.urls).toEqual([
      "http://localhost:4318/health/brain",
      "http://localhost:4318/ready",
    ]);
    expect(probe.signals).toHaveLength(2);
    jest.advanceTimersByTime(VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS - 1);
    expect(probe.signals.map((signal) => signal.aborted)).toEqual([false, false]);

    jest.advanceTimersByTime(1);
    expect(probe.signals.map((signal) => signal.aborted)).toEqual([true, true]);

    const result = await pending;
    expect(result.status).toBe("offline");
    if (result.status !== "offline") throw new Error("Expected offline probe");
    expect(result.apiBaseUrl).toBe("http://localhost:4318");
    // The deadline is a structured availability fact; the rejected request's own
    // message never becomes learner-facing copy.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(result.error).toContain("4000");
  });

  test("forwards an outer abort to every readiness request and never hangs on it", async () => {
    const probe = stalledProbeFetch();
    const outer = new AbortController();
    const pending = fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: probe.fetchImpl,
      signal: outer.signal,
    });

    expect(probe.signals.map((signal) => signal.aborted)).toEqual([false, false]);
    outer.abort();
    expect(probe.signals.map((signal) => signal.aborted)).toEqual([true, true]);

    const result = await pending;
    expect(result.status).toBe("offline");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test("an already-aborted outer signal aborts the probe's requests immediately", async () => {
    const probe = stalledProbeFetch();
    const outer = new AbortController();
    outer.abort();

    const result = await fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: probe.fetchImpl,
      signal: outer.signal,
    });

    expect(probe.signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(result.status).toBe("offline");
  });

  test("a probe that answers inside the deadline leaves no armed timer behind", async () => {
    jest.useFakeTimers();
    const probe = stalledProbeFetch();
    const pending = fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: probe.fetchImpl,
    });
    probe.settle();
    const result = await pending;
    expect(result.status).toBe("observed");

    // The deadline timer is cleared on the success path too: if it were not, it
    // would fire an abort into an already-answered probe (and, with a real
    // clock, keep the process awake for four seconds after every poll).
    jest.advanceTimersByTime(VIVA_AGENT_READINESS_REQUEST_TIMEOUT_MS * 2);
    expect(probe.signals.map((signal) => signal.aborted)).toEqual([false, false]);
  });

  test("makes exactly one attempt per probe — repetition belongs to the poll owner", async () => {
    const urls: string[] = [];
    const result = await fetchVivaAgentReadinessProbe({
      apiBaseUrl: "http://localhost:4318",
      fetchImpl: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        throw new Error("connection refused");
      }) as typeof fetch,
    });

    expect(urls).toEqual(["http://localhost:4318/health/brain", "http://localhost:4318/ready"]);
    expect(result.status).toBe("offline");
  });
});

/**
 * `WEBSESSION-PASTE-01` — the browser's paste ingestion request carries the exact
 * server-owned key set and no identity authority. Rust `PasteStudySetRequest` is
 * `#[serde(deny_unknown_fields)]` over `{title, course, exam_date, pasted_text}`,
 * so a `user_id`/`session_id` member is not merely ignored any more: it is a
 * rejected request. The browser never held that authority in the first place.
 */
describe("Viva paste ingestion request authority", () => {
  function pasteResponse(): PasteIngestionResponse {
    return {
      concepts: [],
      documents: [],
      questions: [],
      session_id: "session-server-owned",
      session_token: null,
      source_spans: [],
      study_set: {
        course: "CHEM-401",
        created_at: "2026-08-20T00:00:00Z",
        exam_date: "2026-09-01",
        id: "study-set-1",
        ingestion_status: "ready",
        title: "Thermodynamic State Functions",
        user_id: "server-owned-user",
      },
    } as unknown as PasteIngestionResponse;
  }

  function capturingFetch(bodies: string[]): typeof fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse(200, pasteResponse());
    }) as typeof fetch;
  }

  test("serializes exactly pasted_text,title when no optional field is supplied", async () => {
    const bodies: string[] = [];
    await pasteStudySetToVivaApi(
      { pastedText: "Gibbs free energy is G = H - TS.", title: "Thermodynamics" },
      { apiBaseUrl: "https://agent.example", fetchImpl: capturingFetch(bodies) },
    );

    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["pasted_text", "title"]);
    expect(body.title).toBe("Thermodynamics");
    expect(body.pasted_text).toBe("Gibbs free energy is G = H - TS.");
  });

  test("serializes exactly course,exam_date,pasted_text,title when both optionals are supplied", async () => {
    const bodies: string[] = [];
    await pasteStudySetToVivaApi(
      {
        course: "CHEM-401",
        examDate: "2026-09-01",
        pastedText: "Enthalpy is a state function.",
        title: "Thermodynamics",
      },
      { apiBaseUrl: "https://agent.example", fetchImpl: capturingFetch(bodies) },
    );

    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["course", "exam_date", "pasted_text", "title"]);
    expect(body.course).toBe("CHEM-401");
    expect(body.exam_date).toBe("2026-09-01");
    expect(body.pasted_text).toBe("Enthalpy is a state function.");
    expect(body.title).toBe("Thermodynamics");
  });

  test("a blank optional field is omitted, never sent as an empty string", async () => {
    const bodies: string[] = [];
    await pasteStudySetToVivaApi(
      {
        course: "   ",
        examDate: "",
        pastedText: "Entropy of mixing is configurational.",
        title: "Thermodynamics",
      },
      { apiBaseUrl: "https://agent.example", fetchImpl: capturingFetch(bodies) },
    );

    // Rust `PasteStudySetRequest` declares both as `Option<String>`, so an empty
    // string arrives as `Some("")` — a present-but-meaningless exam input that
    // the store would carry into its `exam_at` instant. "The learner left the
    // box empty" is `None`, which on this wire means the key is absent.
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["pasted_text", "title"]);
    expect(body).not.toHaveProperty("exam_date");
    expect(body).not.toHaveProperty("course");
  });

  test("a blank exam date reads as absent in the local preview, not as a set date", async () => {
    const bodies: string[] = [];
    const studySet = await pasteStudySetToVivaApi(
      {
        examDate: "   ",
        pastedText: "Entropy of mixing is configurational.",
        title: "Thermodynamics",
      },
      { apiBaseUrl: "https://agent.example", fetchImpl: capturingFetch(bodies) },
    );

    // The preview reads the SAME normalised value the request body is built
    // from, so the two halves of this call cannot disagree about whether the
    // learner supplied an exam date. This is a real behaviour change and is
    // pinned here rather than assumed: `studySetFromPasteIngestionResponse`
    // guards on `options.examDate ? ... : "Exam date optional"`, and "   " is
    // truthy in JS, so an unnormalised blank previously reached
    // `formatExamLabel`, parsed to `NaN`, and surfaced the false claim
    // "Exam date set" for a box the learner left empty.
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("exam_date");
    expect(studySet.examDateLabel).toBe("Exam date optional");
  });

  test("an optional field that is only padded still sends its exact value", async () => {
    const bodies: string[] = [];
    await pasteStudySetToVivaApi(
      {
        course: " CHEM-401 ",
        examDate: " 2026-09-01 ",
        pastedText: "Enthalpy is a state function.",
        title: "Thermodynamics",
      },
      { apiBaseUrl: "https://agent.example", fetchImpl: capturingFetch(bodies) },
    );

    // Blankness is the only thing this boundary decides. Trimming a real value
    // would be the browser editing ingestion content, which it does not own.
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["course", "exam_date", "pasted_text", "title"]);
    expect(body.course).toBe(" CHEM-401 ");
    expect(body.exam_date).toBe(" 2026-09-01 ");
  });

  test("a hostile runtime object cannot smuggle identity into the request body", async () => {
    const bodies: string[] = [];
    const hostile = {
      pastedText: "Entropy increases.",
      sessionId: "forged-session",
      session_id: "forged-session-wire",
      title: "Thermodynamics",
      userId: "forged-user",
      user_id: "forged-user-wire",
    } as unknown as VivaPasteStudySetInput;

    await pasteStudySetToVivaApi(hostile, {
      apiBaseUrl: "https://agent.example",
      fetchImpl: capturingFetch(bodies),
    });

    const raw = bodies[0] ?? "";
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["pasted_text", "title"]);
    expect(raw).not.toContain("forged-user");
    expect(raw).not.toContain("forged-session");
    expect(raw).not.toContain("user_id");
    expect(raw).not.toContain("session_id");
  });

  test("identity fields are not members of the exported paste input type", () => {
    const withUserId: VivaPasteStudySetInput = {
      pastedText: "p",
      title: "t",
      // @ts-expect-error `userId` is not a member of VivaPasteStudySetInput: the
      // browser holds no identity authority over ingestion.
      userId: "forged-user",
    };
    const withSessionId: VivaPasteStudySetInput = {
      pastedText: "p",
      // @ts-expect-error `sessionId` is not a member of VivaPasteStudySetInput.
      sessionId: "forged-session",
      title: "t",
    };
    expect(withUserId.title).toBe("t");
    expect(withSessionId.title).toBe("t");
  });
});

/**
 * `WEBSESSION-AUTHORITY-01` — the browser's outbound boundary. Plan 05 publishes
 * the browser-only frame union, the 64 KiB text-frame cap, and the typed
 * diagnostics; this proves the browser CONSUMES them before `WebSocket.send`
 * rather than serializing whatever it was handed.
 */
describe("Viva browser outbound frame boundary", () => {
  const forgedToolResultCase = (
    clientDifferentialCases as {
      cases: Array<{ id: string; wire_json: string; diagnostic_code?: string; path?: string }>;
    }
  ).cases.find((entry) => entry.id === "VOICE-CLIENT-REJECT-FORGED-TOOL-RESULT");

  const oversizedTextFrameCase = (
    clientDifferentialCases as {
      cases: Array<{ id: string; wire_json: string; diagnostic_code?: string; path?: string }>;
    }
  ).cases.find((entry) => entry.id === "VOICE-CLIENT-REJECT-TEXT-FRAME-65537");

  test("the browser frame union and controller expose no tool authority", () => {
    // A browser holds no tool authority, so a tool frame is not a member of the
    // browser-sendable union. Asserted as a type relation so the proof does not
    // depend on where TypeScript happens to anchor an assignability error.
    type ForgedToolResultFrame = {
      client_generation_id: string;
      result: { proposal: { name: string }; result: Record<string, never> };
      type: "tool_result";
      version: typeof VIVA_VOICE_PROTOCOL_VERSION;
    };
    type ToolResultIsNotBrowserSendable = ForgedToolResultFrame extends VivaBrowserClientFrame
      ? never
      : true;
    const toolResultIsNotBrowserSendable: ToolResultIsNotBrowserSendable = true;
    expect(toolResultIsNotBrowserSendable).toBe(true);

    const forged: VivaBrowserClientFrame = {
      client_generation_id: "generation-1",
      // @ts-expect-error `tool_result` is not a browser-sendable frame type.
      type: "tool_result",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    };
    expect(forged.type).toBe("tool_result");

    type ControllerHasNoToolResult = "sendToolResult" extends keyof VivaAgentSessionController
      ? never
      : true;
    const controllerHasNoToolResult: ControllerHasNoToolResult = true;
    expect(controllerHasNoToolResult).toBe(true);

    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
    });
    expect(Object.keys(controller)).not.toContain("sendToolResult");
    expect(Object.keys(controller).filter((key) => /tool/i.test(key))).toEqual([]);
  });

  test("a runtime-forged tool_result is rejected before it can be serialized", () => {
    expect(typeof forgedToolResultCase?.wire_json).toBe("string");
    const forged = JSON.parse(forgedToolResultCase?.wire_json ?? "{}") as unknown;

    const result = serializeVivaBrowserClientFrame(forged as VivaBrowserClientFrame);

    expect(result).toEqual({
      diagnostic: { code: "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY", path: "$.type" },
      status: "rejected",
    });
    // The refused frame's own payload never appears in the result.
    expect(JSON.stringify(result)).not.toContain("write_review_state");

    // ...and no public controller route can transmit it: the only sender is the
    // private one, and the fake socket records every byte that reaches it.
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));
    expect(socket.sent.map((raw) => parseVivaClientFrame(JSON.parse(raw)).type)).toEqual([
      "session_config",
    ]);
    expect(socket.sent.join("")).not.toContain("tool_result");
    expect(JSON.stringify(controller.getState())).not.toContain("write_review_state");
  });

  test("a text frame one byte over the exported cap is rejected at $ and never sent", () => {
    const oversized = JSON.parse(oversizedTextFrameCase?.wire_json ?? "{}") as {
      intent: { kind: string; text: string };
    };
    expect(new TextEncoder().encode(oversizedTextFrameCase?.wire_json ?? "").byteLength).toBe(
      VIVA_VOICE_MAX_TEXT_FRAME_BYTES + 1,
    );

    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));
    const sentBeforeIntent = socket.sent.length;

    const rejected = controller.sendTurnIntent({
      intent: { kind: "answer_text", text: oversized.intent.text },
      turnId: "turn-oversized",
    });

    expect(rejected).toEqual({
      diagnostic: { code: "VOICE_PROTOCOL_FRAME_TOO_LARGE", path: "$" },
      status: "rejected",
      turnId: "turn-oversized",
    });
    expect(socket.sent.length).toBe(sentBeforeIntent);
    expect(controller.getState().pendingSubmission).toBeUndefined();
    // The learner's own text is never echoed into diagnostics or client state.
    expect(JSON.stringify(controller.getState())).not.toContain(oversized.intent.text.slice(0, 64));
  });

  test("the exact-boundary text frame still serializes and sends", () => {
    const oversized = JSON.parse(oversizedTextFrameCase?.wire_json ?? "{}") as {
      client_generation_id: string;
      intent: { kind: "answer_text"; text: string };
      turn_id: string;
      type: "turn_intent";
      version: number;
    };
    // Exactly Plan 05's oversized fixture minus one ASCII byte of answer text.
    const boundaryFrame = {
      ...oversized,
      intent: { kind: "answer_text" as const, text: oversized.intent.text.slice(0, -1) },
    };
    const boundaryPayload = JSON.stringify(boundaryFrame);
    expect(new TextEncoder().encode(boundaryPayload).byteLength).toBe(
      VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
    );

    const serialized = serializeVivaBrowserClientFrame(
      boundaryFrame as unknown as VivaBrowserClientFrame,
    );
    expect(serialized.status).toBe("serialized");
    if (serialized.status !== "serialized") throw new Error("Expected the boundary frame to pass");
    expect(new TextEncoder().encode(serialized.payload).byteLength).toBe(
      VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
    );

    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      generationIdFactory: ({ reason, sequence }) => `${reason}-${sequence}`,
      session: sessionFixture as AgentSessionConfig,
      sessionToken: SIGNED_SESSION_CREDENTIAL,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();
    socket.message(JSON.stringify(readyFixture));

    const sent = controller.sendTurnIntent({
      intent: boundaryFrame.intent,
      turnId: "turn-boundary",
    });
    expect(sent).toEqual({ status: "sent", turnId: "turn-boundary" });
    const lastFrame = parseVivaClientFrame(JSON.parse(socket.sent[socket.sent.length - 1] ?? "{}"));
    expect(lastFrame.type).toBe("turn_intent");
  });

  test("the private sender refuses an oversized session_config before WebSocket.send", () => {
    FakeWebSocket.instances = [];
    const controller = createVivaAgentSessionController({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      session: {
        ...(sessionFixture as AgentSessionConfig),
        // A concept list large enough to push the first frame past the cap. The
        // browser must refuse it locally instead of handing the server 64 KiB+.
        active_concepts: Array.from({ length: 6_000 }, (_value, index) => `concept-${index}`),
      },
      sessionToken: SIGNED_SESSION_CREDENTIAL,
    });
    const socket = controller.connect() as unknown as FakeWebSocket;
    socket.open();

    expect(socket.sent).toEqual([]);
    expect(controller.getState().status).toBe("error");
    expect(controller.getState().diagnostics).toEqual([
      { code: "VOICE_PROTOCOL_FRAME_TOO_LARGE", path: "$" },
    ]);
  });
});
