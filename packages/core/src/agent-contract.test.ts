import { describe, expect, test } from "bun:test";
import sessionTokenVectorFixture from "../../../agent/fixtures/session-token/v1/vectors.json";
import audioFixture from "../../../agent/fixtures/voice-protocol/client-audio.json";
import fakeEvidencePackFixture from "../../../agent/fixtures/voice-protocol/fake-cartesia-gemini-evidence-pack.json";
import fakeSessionFixture from "../../../agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json";
import manuscriptIntentFixture from "../../../agent/fixtures/voice-protocol/server-event-manuscript-intent.json";
import eventFixture from "../../../agent/fixtures/voice-protocol/server-event-question-started.json";
import structuredErrorFixture from "../../../agent/fixtures/voice-protocol/server-event-structured-error.json";
import readyFixture from "../../../agent/fixtures/voice-protocol/server-ready.json";
import sessionFixture from "../../../agent/fixtures/voice-protocol/session-config.json";
import evidencePackFixture from "../../../agent/fixtures/voice-protocol/synthetic-evidence-pack.json";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/synthetic-study-session.json";
import authDecisionFixture from "../../../agent/fixtures/voice-protocol/v5/auth-decision.json";
import {
  type AgentSessionConfig,
  audioChunkClientFrame,
  audioEndClientFrame,
  parseVivaClientFrame,
  parseVivaServerFrame,
  sessionConfigFrame,
  VIVA_AUDIO_MAX_CHUNK_BYTES,
  VIVA_AUDIO_MAX_CHUNK_SAMPLES,
  VIVA_AUDIO_MAX_TURN_BYTES,
  VIVA_AUDIO_MAX_TURN_SAMPLES,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  VIVA_VOICE_INPUT_ENCODING,
  VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
  VIVA_VOICE_PROTOCOL_VERSION,
  VIVA_VOICE_SAMPLE_RATE_HZ,
} from "./agent-contract";
import { seedStudySets } from "./index";

describe("Viva voice agent contract", () => {
  test("uses protocol v5 because bounded audio turns replace whole-turn audio frames", () => {
    expect(VIVA_VOICE_PROTOCOL_VERSION).toBe(5);
    expect(() =>
      parseVivaServerFrame({
        type: "ready",
        version: 2,
        sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
        input_encoding: VIVA_VOICE_INPUT_ENCODING,
      }),
    ).toThrow("Unsupported Viva voice protocol version");
    expect(() =>
      parseVivaServerFrame({
        type: "ready",
        version: 4,
        sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
        input_encoding: VIVA_VOICE_INPUT_ENCODING,
      }),
    ).toThrow("Unsupported Viva voice protocol version");
  });

  test("publishes the locked protocol v5 audio constants from one 24 kHz literal", () => {
    expect(VIVA_AUDIO_SAMPLE_RATE_HZ).toBe(VIVA_VOICE_SAMPLE_RATE_HZ);
    expect(VIVA_AUDIO_SAMPLE_RATE_HZ).toBe(24_000);
    expect(VIVA_AUDIO_MAX_CHUNK_SAMPLES).toBe(4_096);
    expect(VIVA_AUDIO_MAX_CHUNK_BYTES).toBe(8_192);
    expect(VIVA_AUDIO_MAX_TURN_SAMPLES).toBe(1_080_000);
    expect(VIVA_AUDIO_MAX_TURN_BYTES).toBe(2_160_000);
    expect(VIVA_AUDIO_MAX_CHUNK_BYTES).toBe(VIVA_AUDIO_MAX_CHUNK_SAMPLES * 2);
    expect(VIVA_AUDIO_MAX_TURN_BYTES).toBe(VIVA_AUDIO_MAX_TURN_SAMPLES * 2);
    expect(VIVA_AUDIO_MAX_TURN_SAMPLES).toBe(45 * VIVA_AUDIO_SAMPLE_RATE_HZ);
    expect(VIVA_VOICE_MAX_TEXT_FRAME_BYTES).toBe(64 * 1024);
  });

  test("keeps a maximum-size audio_chunk below the unchanged 64 KiB text frame cap", () => {
    const frame = {
      type: "audio_chunk",
      version: 5,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
      sequence: 0,
      frame: { pcm16_base64: bytesToBase64(new Uint8Array(VIVA_AUDIO_MAX_CHUNK_BYTES)) },
    } as const;

    expect(parseVivaClientFrame(frame)).toEqual(frame);
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(
      VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
    );
  });

  test("parses the exact bounded audio turn lifecycle frames", () => {
    const chunk = audioChunkClientFrame({
      clientGenerationId: "generation-7",
      turnId: "turn-01",
      sequence: 0,
      pcm16Base64: "AQIDBA==",
    });
    const end = audioEndClientFrame({
      clientGenerationId: "generation-7",
      turnId: "turn-01",
      finalSequence: 0,
    });

    expect(parseVivaClientFrame(chunk)).toEqual({
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
      sequence: 0,
      frame: { pcm16_base64: "AQIDBA==" },
    });
    expect(parseVivaClientFrame(end)).toEqual({
      type: "audio_end",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
      final_sequence: 0,
    });
    expect(
      parseVivaServerFrame({
        type: "audio_turn_accepted",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: "generation-7",
        turn_id: "turn-01",
        final_sequence: 0,
      }),
    ).toEqual({
      type: "audio_turn_accepted",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
      final_sequence: 0,
    });
  });

  test("rejects the legacy whole-turn audio frame", () => {
    expect(() =>
      parseVivaClientFrame({
        type: "audio",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        frame: { pcm16_base64: "AQIDBA==" },
      }),
    ).toThrow("Unknown Viva voice client frame");
  });

  test("rejects audio frames with unsafe sequences or missing turn identity", () => {
    const chunk = {
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
      sequence: 0,
      frame: { pcm16_base64: "AQIDBA==" },
    };

    expect(() => parseVivaClientFrame({ ...chunk, sequence: -1 })).toThrow("Invalid sequence");
    expect(() => parseVivaClientFrame({ ...chunk, sequence: 1.5 })).toThrow("Invalid sequence");
    expect(() => parseVivaClientFrame({ ...chunk, sequence: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      "Invalid sequence",
    );
    expect(() => parseVivaClientFrame({ ...chunk, client_generation_id: "" })).toThrow(
      "Missing client_generation_id",
    );
    expect(() => parseVivaClientFrame({ ...chunk, turn_id: "  " })).toThrow("Missing turn_id");
    expect(() => parseVivaClientFrame({ ...chunk, frame: { pcm16_base64: "" } })).toThrow(
      "Missing pcm16_base64",
    );
    // "AQ==" decodes to one odd PCM byte, which cannot be a whole 16-bit sample.
    expect(() => parseVivaClientFrame({ ...chunk, frame: { pcm16_base64: "AQ==" } })).toThrow(
      "Invalid pcm16_base64",
    );
    expect(() =>
      parseVivaClientFrame({
        ...chunk,
        frame: { pcm16_base64: bytesToBase64(new Uint8Array(VIVA_AUDIO_MAX_CHUNK_BYTES + 2)) },
      }),
    ).toThrow("Audio chunk exceeds maximum size");

    const end = {
      type: "audio_end",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
      final_sequence: 0,
    };
    expect(() => parseVivaClientFrame({ ...end, final_sequence: -1 })).toThrow(
      "Invalid final_sequence",
    );
    expect(() => parseVivaClientFrame({ ...end, client_generation_id: undefined })).toThrow(
      "Missing client_generation_id",
    );
    expect(() => parseVivaClientFrame({ ...end, turn_id: undefined })).toThrow("Missing turn_id");
  });

  test("scopes cancellation to one in-progress audio turn or none at all", () => {
    const scoped = {
      type: "cancel",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
      turn_id: "turn-01",
    };

    expect(parseVivaClientFrame(scoped)).toEqual(scoped);
    expect(parseVivaClientFrame({ type: "cancel", version: VIVA_VOICE_PROTOCOL_VERSION })).toEqual({
      type: "cancel",
      version: VIVA_VOICE_PROTOCOL_VERSION,
    });
    expect(() =>
      parseVivaClientFrame({
        type: "cancel",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        turn_id: "turn-01",
      }),
    ).toThrow("Missing client_generation_id");
  });

  test("parses shared ready fixture from Rust service", () => {
    const ready = parseVivaServerFrame(readyFixture);

    if (ready.type !== "ready") throw new Error("Expected ready frame");
    expect(ready.version).toBe(VIVA_VOICE_PROTOCOL_VERSION);
    expect(ready.sample_rate_hz).toBe(VIVA_VOICE_SAMPLE_RATE_HZ);
    expect(ready.input_encoding).toBe(VIVA_VOICE_INPUT_ENCODING);
    expect(ready.brain).toEqual({
      provider: "synthetic",
      configured: true,
      selectable: true,
      live_runtime: false,
    });
    expect(ready.store).toEqual({
      backend: "in_memory",
      available: true,
      durable: false,
      nonce_replay_protection: true,
      raw_audio_persistence: false,
      transcript_persistence: false,
      uuid_schema_translation: true,
    });
  });

  test("parses shared server event fixture from Rust service", () => {
    const frame = parseVivaServerFrame(eventFixture);

    if (frame.type !== "event") throw new Error("Expected event frame");
    expect(frame.event.type).toBe("question_started");
    if (frame.event.type !== "question_started") throw new Error("Expected question event");
    expect(frame.event.response_id).toBe("response-1");
    expect(frame.event.question.source.confidence).toBe("high");
  });

  test("parses terminal session phases with sanitized enum reasons", () => {
    const frame = parseVivaServerFrame({
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: {
        type: "session_phase",
        phase: "recap",
        terminal_reason: "turn_cap",
      },
    });

    if (frame.type !== "event") throw new Error("Expected event frame");
    expect(frame.event).toEqual({
      type: "session_phase",
      phase: "recap",
      terminal_reason: "turn_cap",
    });

    for (const terminalReason of [
      "provider_auth_failed",
      "provider_rate_limited",
      "provider_timeout",
      "provider_malformed_stream",
      "provider_network_disconnect",
      "slow_client",
      "provider_cancelled",
      "partial_stage_success",
      "durability_degraded",
      "tool_executor_failure",
      "rollback",
    ] as const) {
      const parsed = parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "session_phase",
          phase: "recap",
          terminal_reason: terminalReason,
        },
      });
      expect(parsed.type).toBe("event");
    }

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "session_phase",
          phase: "recap",
          terminal_reason: "raw transcript should never be accepted",
        },
      }),
    ).toThrow("Invalid terminal session reason");
  });

  test("parses provider-failure partial recap markers as sanitized terminal reasons", () => {
    const frame = parseVivaServerFrame({
      type: "event",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      event: {
        type: "recap_ready",
        response_id: "response-1",
        partial_reason: "provider_timeout",
        recap: {
          voice_session_id: "voice-session-1",
          headline: "Partial recap",
          summary: "Durable state only.",
          strong_concepts: [],
          shaky_concepts: [],
          missed_concepts: [],
          review_later: [],
          next_action: "Retry when available.",
          source_moments: [],
        },
      },
    });

    if (frame.type !== "event" || frame.event.type !== "recap_ready") {
      throw new Error("Expected recap event frame");
    }
    expect(frame.event.partial_reason).toBe("provider_timeout");

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "recap_ready",
          response_id: "response-1",
          partial_reason: "raw provider payload",
          recap: {
            voice_session_id: "voice-session-1",
            headline: "Partial recap",
            summary: "Durable state only.",
            strong_concepts: [],
            shaky_concepts: [],
            missed_concepts: [],
            review_later: [],
            next_action: "Retry when available.",
            source_moments: [],
          },
        },
      }),
    ).toThrow("Invalid terminal session reason");
  });

  test("parses shared structured error fixture from Rust service", () => {
    const frame = parseVivaServerFrame(structuredErrorFixture);

    if (frame.type !== "event") throw new Error("Expected event frame");
    expect(frame.event.type).toBe("structured_error");
    if (frame.event.type !== "structured_error") throw new Error("Expected structured error");
    expect(frame.event.source).toBe("agent-service");
  });

  test("parses shared manuscript intent fixture from Rust service", () => {
    const frame = parseVivaServerFrame(manuscriptIntentFixture);

    if (frame.type !== "event") throw new Error("Expected event frame");
    expect(frame.event.type).toBe("manuscript_intent");
    if (frame.event.type !== "manuscript_intent") throw new Error("Expected manuscript intent");
    expect(frame.event.response_id).toBe("response-1");
    expect(frame.event.intent).toEqual({
      type: "scene_intent",
      register: "examining",
      emphasis: "measured",
    });
  });

  test("rejects manuscript intents that try to carry render instructions", () => {
    for (const key of ["color", "coordinates", "x", "y", "css", "markup", "html", "draw"]) {
      expect(() =>
        parseVivaServerFrame({
          type: "event",
          version: VIVA_VOICE_PROTOCOL_VERSION,
          event: {
            type: "manuscript_intent",
            response_id: "response-1",
            intent: {
              type: "scene_intent",
              register: "examining",
              emphasis: "quiet",
              [key]: "bad",
            },
          },
        }),
      ).toThrow("Invalid manuscript intent");
    }
  });

  test("rejects invalid or oversized manuscript intent fields", () => {
    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: { type: "scene_intent", register: "glitter", emphasis: "quiet" },
        },
      }),
    ).toThrow("Invalid manuscript register");

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: { type: "scene_intent", register: "examining", emphasis: "neon" },
        },
      }),
    ).toThrow("Invalid manuscript emphasis");

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: {
            type: "entity_intent",
            entity_id: "",
            entity_kind: "concept",
            register: "examining",
            emphasis: "quiet",
          },
        },
      }),
    ).toThrow("Missing entity_id");

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: {
            type: "entity_intent",
            entity_id: "<b>nadh</b>",
            entity_kind: "concept",
            register: "examining",
            emphasis: "quiet",
          },
        },
      }),
    ).toThrow("Invalid manuscript entity_id");

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "manuscript_intent",
          response_id: "response-1",
          intent: {
            type: "marginalia_intent",
            marginalia_id: "a".repeat(97),
            anchor_entity_id: "nadh",
            register: "reflecting",
            emphasis: "marked",
          },
        },
      }),
    ).toThrow("Invalid manuscript marginalia_id");
  });

  test("builds and parses shared audio chunk fixture", () => {
    const frame = audioChunkClientFrame({
      clientGenerationId: "1",
      turnId: "turn-1",
      sequence: 0,
      pcm16Base64: "AQIDBA==",
    });
    const parsedFixture = parseVivaClientFrame(audioFixture);

    expect(parsedFixture).toEqual(frame);
    expect(JSON.stringify(frame)).toBe(JSON.stringify(audioFixture));
  });

  test("builds typed session config frame from shared fixture", () => {
    const frame = sessionConfigFrame(sessionFixture as unknown as AgentSessionConfig);
    if (frame.type !== "session_config") throw new Error("Expected session config frame");

    expect(parseVivaClientFrame(frame)).toEqual(frame);
    expect(frame.session.mode).toBe("quiz");
    expect(frame.session.source_context[0]?.confidence).toBe("high");
  });

  test("keeps shared agent concept ids inside the Biology study-set vocabulary", () => {
    const biology = seedStudySets.find((studySet) => studySet.id === "biology-midterm");
    const vocabulary = new Set(biology?.concepts.map((concept) => concept.id) ?? []);
    const fixtureIds = new Set([
      ...(sessionFixture as AgentSessionConfig).active_concepts,
      ...activeConceptIdsFromFixture(fullSessionFixture),
      ...activeConceptIdsFromFixture(fakeSessionFixture),
      ...conceptStatusIdsFromFixture(fullSessionFixture),
      ...conceptStatusIdsFromFixture(fakeSessionFixture),
    ]);

    const missing = [...fixtureIds].filter((conceptId) => !vocabulary.has(conceptId));

    expect(missing).toEqual([]);
  });

  test("rejects browser-authority client frames", () => {
    expect(() =>
      parseVivaClientFrame({
        type: "session_config",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        session: {
          user_id: "user-1",
          study_set_id: "biology-midterm",
          source_context: [],
          active_concepts: [],
        },
      }),
    ).toThrow("Missing session_id");

    expect(() =>
      parseVivaClientFrame({
        type: "tool_result",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        result: {
          proposal: { name: "evaluate_spoken_answer", arguments: {} },
          result: { accepted: true },
        },
      }),
    ).toThrow("Browser tool_result frames are not accepted");
  });

  test("parses shared synthetic study session fixture", () => {
    const serverFrames = fullSessionFixture.server.map(parseVivaServerFrame);
    const clientFrames = fullSessionFixture.client.map(parseVivaClientFrame);

    expect(clientFrames[0]?.type).toBe("session_config");
    expect(serverFrames.some((frame) => frame.type === "ready")).toBe(true);
    expect(
      serverFrames.some(
        (frame) => frame.type === "event" && frame.event.type === "answer_evaluated",
      ),
    ).toBe(true);
    expect(
      serverFrames.some((frame) => frame.type === "event" && frame.event.type === "recap_ready"),
    ).toBe(true);
  });

  test("parses shared fake Cartesia/Gemini study session fixture", () => {
    const serverFrames = fakeSessionFixture.server.map(parseVivaServerFrame);
    const clientFrames = fakeSessionFixture.client.map(parseVivaClientFrame);
    const eventTypes = serverFrames.flatMap((frame) =>
      frame.type === "event" ? [frame.event.type] : [],
    );

    expect(clientFrames[0]?.type).toBe("session_config");
    expect(clientFrames[1]?.type).toBe("audio_chunk");
    expect(clientFrames[2]?.type).toBe("audio_end");
    expect(serverFrames[0]?.type).toBe("ready");
    expect(serverFrames[3]?.type).toBe("audio_turn_accepted");
    expect(eventTypes).toEqual([
      "session_phase",
      "question_started",
      "session_phase",
      "transcript_delta",
      "transcript_final",
      "session_phase",
      "answer_evaluated",
      "manuscript_intent",
      "source_reference",
      "concept_status",
      "audio_delta",
      "session_phase",
      "session_phase",
      "recap_ready",
      "session_phase",
      "cancellation",
    ]);
    const browserEvents = fakeSessionFixture.server.filter((frame) => frame.type === "event");
    expect(JSON.stringify(browserEvents)).not.toContain("usage");
    expect(JSON.stringify(browserEvents)).not.toContain("fake_cartesia_gemini");
  });

  test("keeps synthetic evidence pack sanitized and tied to release contract", () => {
    expect(evidencePackFixture.store_snapshot).toEqual({
      sessions: 1,
      answer_attempts: 1,
      concept_statuses: 1,
      review_items: 1,
      recaps: 1,
      durable: false,
    });
    expect(evidencePackFixture.usage).toEqual({
      events: 1,
      provider: "synthetic",
      model: "synthetic-viva",
      duration_seconds_min: 1,
      text_input_tokens: 20,
      text_output_tokens: 10,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
      cost_estimate_usd: 0.00002,
      answer_eval_latency_ms_present: true,
      source_grounded_correction_count: 1,
    });
    expect(evidencePackFixture.terminal_close_reason).toBe("client_stop");

    const serialized = JSON.stringify(evidencePackFixture);
    expect(serialized).not.toContain("NADH gives electrons");
    expect(serialized).not.toContain("NADH donates high-energy electrons");
    expect(serialized).not.toContain("answer_text");
    expect(serialized).not.toContain("transcript_text");
    expect(serialized).not.toContain("raw_audio");
  });

  test("keeps fake Cartesia/Gemini evidence pack sanitized and tied to release contract", () => {
    expect(fakeEvidencePackFixture.client_frame_count).toBe(fakeSessionFixture.client.length);
    expect(fakeEvidencePackFixture.server_frame_count).toBe(fakeSessionFixture.server.length);
    expect(fakeEvidencePackFixture.store_snapshot).toEqual({
      sessions: 1,
      answer_attempts: 1,
      concept_statuses: 1,
      review_items: 1,
      recaps: 1,
      durable: false,
    });
    expect(fakeEvidencePackFixture.usage).toEqual({
      events: 1,
      provider: "fake_cartesia_gemini",
      model: "fake_cartesia_gemini-viva",
      duration_seconds_min: 1,
      text_input_tokens: 20,
      text_output_tokens: 10,
      audio_input_tokens: 0,
      audio_output_tokens: 0,
      cost_estimate_usd: 0.00002,
      answer_eval_latency_ms_present: true,
      source_grounded_correction_count: 1,
    });
    expect(fakeEvidencePackFixture.terminal_close_reason).toBe("client_stop");

    const serialized = JSON.stringify(fakeEvidencePackFixture);
    expect(serialized).not.toContain("AQIDBA==");
    expect(serialized).not.toContain("received 4 PCM16 bytes");
    expect(serialized).not.toContain("answer_text");
    expect(serialized).not.toContain("transcript_text");
    expect(serialized).not.toContain("raw_audio");
  });

  test("rejects fail-open answer evaluations and source tuples", () => {
    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "answer_evaluated",
          response_id: "response-1",
          evaluation: {
            question_id: "q-1",
            answer_text: "answer",
            label: "pretty good",
            concise_feedback: "Feedback.",
            retry_prompt: "Try again.",
            source: {
              source_id: "src-1",
              document_id: "doc-1",
              span: "slide:1",
              excerpt: "Excerpt.",
              confidence: "high",
              retrieval_reason: "server retrieval",
            },
            concept_status: "strong",
            confidence_score: 0.9,
          },
        },
      }),
    ).toThrow("Invalid evaluation label");

    expect(() =>
      parseVivaServerFrame({
        type: "event",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        event: {
          type: "answer_evaluated",
          response_id: "response-1",
          evaluation: {
            question_id: "q-1",
            answer_text: "answer",
            label: "mostly correct",
            concise_feedback: "Feedback.",
            retry_prompt: "Try again.",
            source: {
              source_id: "src-1",
              document_id: "",
              span: "slide:1",
              excerpt: "Excerpt.",
              confidence: "high",
              retrieval_reason: "server retrieval",
            },
            concept_status: "strong",
            confidence_score: 1.2,
          },
        },
      }),
    ).toThrow("Missing document_id");
  });
});

type SessionTokenVectorCase = {
  id: string;
  token: string;
  claims: Record<string, unknown> | null;
  valid: boolean;
  rejection: string | null;
};

type SessionTokenVectorFile = {
  version: number;
  fake_secret_base64: string;
  clock_unix_seconds: number;
  cases: SessionTokenVectorCase[];
};

/** VOICE-TOKEN-001: the closed rejection vocabulary Rust and Node must both use. */
const SESSION_TOKEN_REJECTIONS = [
  "malformed_shape",
  "noncanonical_base64url",
  "unknown_claim",
  "invalid_signature",
  "malformed_json",
  "duplicate_claim",
  "not_yet_valid",
  "expired",
  "invalid_time_order",
  "binding_mismatch",
  "missing_claim",
] as const;

/** The exact required case-id set; adding or removing one needs a Plan 05 amendment. */
const SESSION_TOKEN_VECTOR_EXPECTATIONS: ReadonlyArray<readonly [string, boolean, string | null]> =
  [
    ["VOICE-TOKEN-VALID-CANONICAL", true, null],
    ["VOICE-TOKEN-VALID-FAILURE-CONTROL", true, null],
    ["VOICE-TOKEN-REJECT-SEGMENT-SHAPE", false, "malformed_shape"],
    ["VOICE-TOKEN-REJECT-WRONG-PREFIX", false, "malformed_shape"],
    ["VOICE-TOKEN-REJECT-PADDED-CLAIMS", false, "noncanonical_base64url"],
    ["VOICE-TOKEN-REJECT-PADDED-SIGNATURE", false, "noncanonical_base64url"],
    ["VOICE-TOKEN-REJECT-NONCANONICAL-BASE64URL", false, "noncanonical_base64url"],
    ["VOICE-TOKEN-REJECT-UNKNOWN-CLAIM", false, "unknown_claim"],
    ["VOICE-TOKEN-REJECT-UNKNOWN-FAILURE-CONTROL-CLAIM", false, "unknown_claim"],
    ["VOICE-TOKEN-REJECT-BAD-HMAC", false, "invalid_signature"],
    ["VOICE-TOKEN-REJECT-MALFORMED-JSON", false, "malformed_json"],
    ["VOICE-TOKEN-REJECT-DUPLICATE-JSON-KEY", false, "duplicate_claim"],
    ["VOICE-TOKEN-REJECT-NOT-BEFORE", false, "not_yet_valid"],
    ["VOICE-TOKEN-REJECT-EXPIRES-AT", false, "expired"],
    ["VOICE-TOKEN-REJECT-ISSUED-ORDER", false, "invalid_time_order"],
    ["VOICE-TOKEN-REJECT-USER-BINDING", false, "binding_mismatch"],
    ["VOICE-TOKEN-REJECT-STUDY-SET-BINDING", false, "binding_mismatch"],
    ["VOICE-TOKEN-REJECT-SESSION-BINDING", false, "binding_mismatch"],
    ["VOICE-TOKEN-REJECT-EMPTY-NONCE", false, "missing_claim"],
  ];

/** The exact `failure_control.scenario` vocabulary shared with the Rust service. */
const FAILURE_CONTROL_SCENARIOS = [
  "provider_rate_limited",
  "provider_auth_failed",
  "provider_timeout",
  "silent_stall",
  "provider_malformed_stream",
  "provider_network_disconnect",
  "sonic_tts_timeout",
  "recap_timeout",
  "invalid_token",
  "expired_token",
  "replayed_token",
  "malformed_token",
  "slow_stale_socket_close",
  "double_submit_race",
  "mic_denied",
  "typed_fallback",
] as const;

/**
 * The canonical fake access token VOICE-AUTH-001 pins in the signed first frame.
 * It is the same string as the canonical vector so Rust, Node, and the wire fixture
 * cannot drift apart. Fixture-only credential: the secret is the published fake key.
 */
const CANONICAL_FIXTURE_SESSION_TOKEN =
  "viva1.eyJ1c2VyX2lkIjoiZml4dHVyZS11c2VyIiwic3R1ZHlfc2V0X2lkIjoiZml4dHVyZS1zdHVkeS1zZXQiLCJzZXNzaW9uX2lkIjoiZml4dHVyZS1zZXNzaW9uIiwiaXNzdWVkX2F0IjoxODAwMDAwMDAwLCJub3RfYmVmb3JlIjoxODAwMDAwMDAwLCJleHBpcmVzX2F0IjoxODAwMDAwOTAwLCJub25jZSI6ImZpeHR1cmUtbm9uY2UtMDAxIn0.JcnhtQUxeV1XJm0RYGo7LuL5yph5SeRaFch8-Iz8_rA";

const sessionTokenVectors = sessionTokenVectorFixture as unknown as SessionTokenVectorFile;

describe("Viva voice v5 authentication decision and shared session-token vectors", () => {
  test("records the sponsor-selected D-07 retain-token-only branch verbatim", () => {
    expect(Object.keys(authDecisionFixture)).toEqual([
      "decision",
      "branch",
      "direct_browser_wss",
      "preupgrade_auth",
      "first_frame_auth",
      "refresh_mode",
      "browser_refresh_absolute_lifetime_required",
      "in_socket_token_refresh",
    ]);
    expect(authDecisionFixture).toEqual({
      decision: "D-07 TOKEN_ONLY_REFRESH",
      branch: "retain-token-only",
      direct_browser_wss: true,
      preupgrade_auth: "signed_session_access_token",
      first_frame_auth: "same_signed_session_access_token",
      refresh_mode: "rotating_one_time_hashed_credential",
      browser_refresh_absolute_lifetime_required: true,
      in_socket_token_refresh: false,
    });
    // Branch A's refresh credential is never a viva1 access token and never appears
    // in this contract fixture; token renewal always replaces the socket.
    const serialized = JSON.stringify(authDecisionFixture);
    expect(serialized).not.toContain("viva1.");
    expect(serialized).not.toContain("Bearer ");
  });

  test("publishes the exact v1 vector schema, fake secret, and pinned runner clock", () => {
    expect(Object.keys(sessionTokenVectors)).toEqual([
      "version",
      "fake_secret_base64",
      "clock_unix_seconds",
      "cases",
    ]);
    expect(sessionTokenVectors.version).toBe(1);
    expect(sessionTokenVectors.fake_secret_base64).toBe(
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    );
    expect([...base64ToBytes(sessionTokenVectors.fake_secret_base64)]).toEqual(
      Array.from({ length: 32 }, (_unused, index) => index),
    );
    // The clock sits inside the canonical fixture window [1800000000, 1800000900).
    expect(sessionTokenVectors.clock_unix_seconds).toBe(1_800_000_300);
    for (const vector of sessionTokenVectors.cases) {
      expect(Object.keys(vector)).toEqual(["id", "token", "claims", "valid", "rejection"]);
    }
  });

  test("pins the exact required case-id set with closed rejection strings", () => {
    expect(sessionTokenVectors.cases.map((vector) => vector.id)).toEqual(
      SESSION_TOKEN_VECTOR_EXPECTATIONS.map(([id]) => id),
    );

    for (const [id, valid, rejection] of SESSION_TOKEN_VECTOR_EXPECTATIONS) {
      const vector = sessionTokenVectorCase(id);
      expect({ valid: vector.valid, rejection: vector.rejection }).toEqual({ valid, rejection });
      expect(vector.valid).toBe(vector.rejection === null);
      if (vector.rejection !== null) {
        expect(SESSION_TOKEN_REJECTIONS).toContain(
          vector.rejection as (typeof SESSION_TOKEN_REJECTIONS)[number],
        );
      }
    }
  });

  test("keeps every recorded claim set identical to its own token claims segment", () => {
    for (const vector of sessionTokenVectors.cases) {
      const segments = vector.token.split(".");
      if (vector.id === "VOICE-TOKEN-REJECT-SEGMENT-SHAPE") {
        expect(segments).toHaveLength(2);
        expect(segments[0]).toBe("viva1");
        continue;
      }
      expect(segments).toHaveLength(3);
      expect(segments[0]).toBe(vector.id === "VOICE-TOKEN-REJECT-WRONG-PREFIX" ? "viva2" : "viva1");
      if (vector.claims === null) continue;
      expect(decodeBase64UrlJson(segments[1] ?? "")).toEqual(vector.claims);
    }
  });

  test("isolates exactly one defect per rejecting vector", () => {
    const clock = sessionTokenVectors.clock_unix_seconds;
    const noncanonicalIds = new Set([
      "VOICE-TOKEN-REJECT-PADDED-CLAIMS",
      "VOICE-TOKEN-REJECT-PADDED-SIGNATURE",
      "VOICE-TOKEN-REJECT-NONCANONICAL-BASE64URL",
    ]);

    expect(sessionTokenVectorCase("VOICE-TOKEN-VALID-CANONICAL").token).toBe(
      CANONICAL_FIXTURE_SESSION_TOKEN,
    );
    expect(sessionTokenVectorClaims("VOICE-TOKEN-VALID-CANONICAL")).toEqual({
      user_id: "fixture-user",
      study_set_id: "fixture-study-set",
      session_id: "fixture-session",
      issued_at: 1_800_000_000,
      not_before: 1_800_000_000,
      expires_at: 1_800_000_900,
      nonce: "fixture-nonce-001",
    });
    expect(Object.keys(sessionTokenVectorClaims("VOICE-TOKEN-VALID-FAILURE-CONTROL"))).toEqual([
      "user_id",
      "study_set_id",
      "session_id",
      "issued_at",
      "not_before",
      "expires_at",
      "nonce",
      "failure_control",
    ]);
    const failureControl = sessionTokenVectorClaims("VOICE-TOKEN-VALID-FAILURE-CONTROL")
      .failure_control as Record<string, unknown>;
    expect(Object.keys(failureControl)).toEqual([
      "scenario",
      "run_id",
      "expires_at",
      "nonce",
      "signature",
    ]);
    expect(FAILURE_CONTROL_SCENARIOS).toContain(
      failureControl.scenario as (typeof FAILURE_CONTROL_SCENARIOS)[number],
    );

    // Time defects, each against the pinned clock and the issued/not-before/expiry order.
    expect(
      sessionTokenVectorClaims("VOICE-TOKEN-REJECT-NOT-BEFORE").not_before as number,
    ).toBeGreaterThan(clock);
    expect(
      sessionTokenVectorClaims("VOICE-TOKEN-REJECT-EXPIRES-AT").expires_at as number,
    ).toBeLessThanOrEqual(clock);
    const outOfOrder = sessionTokenVectorClaims("VOICE-TOKEN-REJECT-ISSUED-ORDER");
    expect(outOfOrder.issued_at as number).toBeGreaterThan(outOfOrder.not_before as number);

    // Binding defects, each against the canonical expected binding.
    expect(sessionTokenVectorClaims("VOICE-TOKEN-REJECT-USER-BINDING").user_id).not.toBe(
      "fixture-user",
    );
    expect(sessionTokenVectorClaims("VOICE-TOKEN-REJECT-STUDY-SET-BINDING").study_set_id).not.toBe(
      "fixture-study-set",
    );
    expect(sessionTokenVectorClaims("VOICE-TOKEN-REJECT-SESSION-BINDING").session_id).not.toBe(
      "fixture-session",
    );
    expect(sessionTokenVectorClaims("VOICE-TOKEN-REJECT-EMPTY-NONCE").nonce).toBe("");
    expect(sessionTokenVectorClaims("VOICE-TOKEN-REJECT-UNKNOWN-CLAIM")).toHaveProperty("role");
    expect(
      Object.keys(
        sessionTokenVectorClaims("VOICE-TOKEN-REJECT-UNKNOWN-FAILURE-CONTROL-CLAIM")
          .failure_control as Record<string, unknown>,
      ),
    ).toContain("origin");

    // Encoding defects are confined to the three cases that own them.
    for (const vector of sessionTokenVectors.cases) {
      const segments = vector.token.split(".");
      const canonicalSegments = segments
        .slice(1)
        .every((segment) => isCanonicalUnpaddedBase64Url(segment));
      expect(canonicalSegments).toBe(!noncanonicalIds.has(vector.id));
    }
  });

  test("keeps every vector credential clearly fixture-only", () => {
    const serialized = JSON.stringify(sessionTokenVectors);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("AIza");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");

    for (const vector of sessionTokenVectors.cases) {
      if (vector.claims === null) continue;
      for (const key of ["user_id", "study_set_id", "session_id"] as const) {
        const value = vector.claims[key];
        if (typeof value === "string") {
          expect(value.startsWith("fixture-")).toBe(true);
        }
      }
    }
  });
});

function sessionTokenVectorCase(id: string): SessionTokenVectorCase {
  const vector = sessionTokenVectors.cases.find((candidate) => candidate.id === id);
  if (!vector) throw new Error(`Missing session-token vector ${id}`);
  return vector;
}

function sessionTokenVectorClaims(id: string): Record<string, unknown> {
  const claims = sessionTokenVectorCase(id).claims;
  if (!claims) throw new Error(`Session-token vector ${id} records no claims`);
  return claims;
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeBase64UrlJson(segment: string): unknown {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(new TextDecoder().decode(base64ToBytes(padded)));
}

function isCanonicalUnpaddedBase64Url(segment: string): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(segment) || segment.length % 4 === 1) return false;
  const bytes = base64ToBytes(segment.replace(/-/g, "+").replace(/_/g, "/"));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const reencoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return reencoded === segment;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function activeConceptIdsFromFixture(fixture: { client: unknown[] }): string[] {
  return fixture.client.flatMap((frame) => {
    const parsed = parseVivaClientFrame(frame);
    return parsed.type === "session_config" ? parsed.session.active_concepts : [];
  });
}

function conceptStatusIdsFromFixture(fixture: { server: unknown[] }): string[] {
  return fixture.server.flatMap((frame) => {
    const parsed = parseVivaServerFrame(frame);
    if (parsed.type !== "event" || parsed.event.type !== "concept_status") {
      return [];
    }
    return [parsed.event.concept_id];
  });
}
