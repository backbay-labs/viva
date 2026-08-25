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
import clientDifferentialFixture from "../../../agent/fixtures/voice-protocol/v5/client-differential-cases.json";
import signedSessionConfigFixture from "../../../agent/fixtures/voice-protocol/v5/client-session-config-signed.json";
import sessionRefreshFixture from "../../../agent/fixtures/voice-protocol/v5/client-session-refresh.json";
import serverDifferentialFixture from "../../../agent/fixtures/voice-protocol/v5/server-differential-cases.json";
import readyV5Fixture from "../../../agent/fixtures/voice-protocol/v5/server-ready.json";
import {
  type AgentSessionConfig,
  audioChunkClientFrame,
  audioEndClientFrame,
  negotiateVivaVoiceProtocolVersion,
  parseVivaClientFrame,
  parseVivaClientFrameJson,
  parseVivaServerFrame,
  parseVivaServerFrameJson,
  sessionConfigFrame,
  VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS,
  VIVA_AUDIO_MAX_CHUNK_BYTES,
  VIVA_AUDIO_MAX_CHUNK_SAMPLES,
  VIVA_AUDIO_MAX_TURN_BYTES,
  VIVA_AUDIO_MAX_TURN_SAMPLES,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  VIVA_BROWSER_CLIENT_FRAME_TYPES,
  VIVA_VOICE_BYTES_PER_SAMPLE,
  VIVA_VOICE_CHANNELS,
  VIVA_VOICE_DIAGNOSTIC_CODES,
  VIVA_VOICE_INPUT_ENCODING,
  VIVA_VOICE_MAX_TEXT_FRAME_BYTES,
  VIVA_VOICE_MAX_TURN_SECONDS,
  VIVA_VOICE_PROTOCOL_ADVERTISEMENT,
  VIVA_VOICE_PROTOCOL_VERSION,
  VIVA_VOICE_SAMPLE_RATE_HZ,
  VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS,
  VivaVoiceProtocolError,
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
    // A present-but-blank id is invalid; an absent one is missing.
    expect(() => parseVivaClientFrame({ ...chunk, client_generation_id: "" })).toThrow(
      "Invalid client_generation_id",
    );
    expect(() => parseVivaClientFrame({ ...chunk, turn_id: "  " })).toThrow("Invalid turn_id");
    expect(() => parseVivaClientFrame({ ...chunk, frame: { pcm16_base64: "" } })).toThrow(
      "Invalid pcm16_base64",
    );
    expect(() => parseVivaClientFrame({ ...chunk, frame: {} })).toThrow("Missing pcm16_base64");
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
    const finalSequence = captureVoiceProtocolError(() =>
      parseVivaClientFrame({ ...end, final_sequence: -1 }),
    );
    expect(finalSequence.code).toBe("VOICE_PROTOCOL_INVALID_FIELD");
    expect(finalSequence.path).toBe("$.final_sequence");
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
    const generationScoped = {
      type: "cancel",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-7",
    };

    expect(parseVivaClientFrame(scoped)).toEqual(scoped);
    expect(parseVivaClientFrame(generationScoped)).toEqual(generationScoped);
    // Cancellation is generation-bound in v5 even when it names no turn, so it can
    // never reach another generation.
    expect(() =>
      parseVivaClientFrame({
        type: "cancel",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        turn_id: "turn-01",
      }),
    ).toThrow("Missing client_generation_id");
  });

  test("rejects the retiring unversioned ready fixture as pre-v5", () => {
    // `VOICE-READY-001` makes the protocol advertisement a required ready field. The
    // frozen root corpus predates it, so strict v5 parsing rejects it instead of
    // inventing an advertisement. Task 9 Step 6 deletes the corpus outright.
    const rejection = captureVoiceProtocolError(() => parseVivaServerFrame(readyFixture));
    expect(rejection.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(rejection.path).toBe("$.protocol");
  });

  test("rejects the retiring unversioned question fixture as pre-v5", () => {
    // The merged Plan 06 `StudyQuestion` carries `concept_id` and `rubric`; the frozen
    // root event corpus predates both, so strict v5 parsing rejects it.
    const rejection = captureVoiceProtocolError(() => parseVivaServerFrame(eventFixture));
    expect(rejection.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(rejection.path).toBe("$.event.question.concept_id");
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
          schema: "viva.study_session_recap.v2",
          voice_session_id: "voice-session-1",
          headline: "Partial recap",
          summary: "Durable state only.",
          concepts: [],
          review_schedule: [],
          next_action: "Retry when available.",
          source_moments: [],
          deferred_turns: 0,
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
            schema: "viva.study_session_recap.v2",
            voice_session_id: "voice-session-1",
            headline: "Partial recap",
            summary: "Durable state only.",
            concepts: [],
            review_schedule: [],
            next_action: "Retry when available.",
            source_moments: [],
            deferred_turns: 0,
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
      ).toThrow("Unknown Viva voice field");
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
    ).toThrow("Invalid id");

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
    ).toThrow("Invalid id");

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
    ).toThrow("Invalid manuscript id");
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

  test("builds the typed signed session config frame from the v5 fixture", () => {
    const frame = sessionConfigFrame(
      signedSessionConfigFixture.session as unknown as AgentSessionConfig,
      signedSessionConfigFixture.session_token,
      signedSessionConfigFixture.client_generation_id,
    );

    expect(parseVivaClientFrame(frame)).toEqual(frame);
    expect(frame.session.mode).toBe("quiz");
    expect(JSON.stringify(frame)).toBe(JSON.stringify(signedSessionConfigFixture));
  });

  test("keeps shared agent concept ids inside the Biology study-set vocabulary", () => {
    const biology = seedStudySets.find((studySet) => studySet.id === "biology-midterm");
    const vocabulary = new Set(biology?.concepts.map((concept) => concept.id) ?? []);
    // The frozen unversioned corpus is v4 wire shape, so its concept ids are read
    // structurally rather than through the v5 client parser (Task 9 Step 6 retires it).
    const fixtureIds = new Set([
      ...(sessionFixture as AgentSessionConfig).active_concepts,
      ...legacyActiveConceptIds(fullSessionFixture),
      ...legacyActiveConceptIds(fakeSessionFixture),
      ...conceptStatusIdsFromFixture(fullSessionFixture),
      ...conceptStatusIdsFromFixture(fakeSessionFixture),
    ]);

    const missing = [...fixtureIds].filter((conceptId) => !vocabulary.has(conceptId));

    expect(missing).toEqual([]);
  });

  test("rejects browser-authority client frames", () => {
    const missingIdentity = captureVoiceProtocolError(() =>
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
    );
    expect(missingIdentity.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(missingIdentity.path).toBe("$.client_generation_id");

    const forgedToolResult = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        type: "tool_result",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        result: {
          proposal: { name: "evaluate_spoken_answer", arguments: {} },
          result: { accepted: true },
        },
      }),
    );
    expect(forgedToolResult.code).toBe("VOICE_PROTOCOL_FORBIDDEN_AUTHORITY");
    expect(forgedToolResult.path).toBe("$.type");
  });

  test("rejects the frozen unversioned synthetic session corpus in both directions", () => {
    // `VOICE-VERSION-001`: the frozen corpus is v4 wire shape — token-less
    // `session_config`, plain `text`, ready frames without the advertisement, and
    // questions without `concept_id`/`rubric`. v5 rejects it rather than silently
    // upgrading it, and Task 9 Step 6 deletes it outright.
    for (const frame of fullSessionFixture.client) {
      expect(VIVA_VOICE_DIAGNOSTIC_CODES).toContain(
        captureVoiceProtocolError(() => parseVivaClientFrame(frame)).code,
      );
    }
    const readyRejection = captureVoiceProtocolError(() =>
      parseVivaServerFrame(fullSessionFixture.server[0]),
    );
    expect(readyRejection.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(readyRejection.path).toBe("$.protocol");

    // The corpus still records the shapes the v5 corpus must eventually cover.
    const eventTypes = fullSessionFixture.server.flatMap((frame) =>
      frame.type === "event" ? [(frame as { event: { type: string } }).event.type] : [],
    );
    expect(eventTypes).toContain("answer_evaluated");
    expect(eventTypes).toContain("recap_ready");
  });

  test("rejects the frozen unversioned fake-provider corpus but keeps its audio shape", () => {
    // The v4 `session_config` carries no signed credential and the ready frame carries
    // no advertisement, so both reject; the bounded audio frames Plan 03 introduced are
    // already v5 shaped and still parse.
    expect(
      captureVoiceProtocolError(() => parseVivaClientFrame(fakeSessionFixture.client[0])).code,
    ).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(parseVivaClientFrame(fakeSessionFixture.client[1]).type).toBe("audio_chunk");
    expect(parseVivaClientFrame(fakeSessionFixture.client[2]).type).toBe("audio_end");
    expect(
      captureVoiceProtocolError(() => parseVivaServerFrame(fakeSessionFixture.server[0])).path,
    ).toBe("$.protocol");
    expect(parseVivaServerFrame(fakeSessionFixture.server[3]).type).toBe("audio_turn_accepted");

    const eventTypes = fakeSessionFixture.server.flatMap((frame) =>
      frame.type === "event" ? [(frame as { event: { type: string } }).event.type] : [],
    );
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
    ).toThrow("Invalid confidence_score");
  });
});

/**
 * `VOICE-READY-001`'s canonical ready frame, transcribed here from the contract rather
 * than read back from `server-ready.json`. Comparing a parse result only against the
 * fixture it just parsed would let a drifted canonical value round-trip undetected on
 * this side; Rust pins the same values from the other direction.
 */
const CANONICAL_V5_READY = {
  type: "ready",
  version: 5,
  protocol: { preferred_version: 5, supported_versions: [5] },
  sample_rate_hz: 24000,
  input_encoding: "pcm_s16le",
  brain: { provider: "synthetic", configured: true, selectable: true, live_runtime: false },
  store: {
    backend: "in_memory",
    available: true,
    durable: false,
    nonce_replay_protection: true,
    raw_audio_persistence: false,
    transcript_persistence: false,
    uuid_schema_translation: true,
  },
} as const;

describe("Viva voice v5 protocol negotiation and the single ready representation", () => {
  test("pins the canonical v5 ready fixture to the contract values", () => {
    expect(readyV5Fixture).toEqual(CANONICAL_V5_READY);
    expect(JSON.stringify(readyV5Fixture)).toBe(JSON.stringify(CANONICAL_V5_READY));
  });

  test("advertises protocol v5 as the only supported version", () => {
    expect(VIVA_VOICE_PROTOCOL_VERSION).toBe(5);
    expect(VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS).toEqual([5]);
    expect(VIVA_VOICE_PROTOCOL_ADVERTISEMENT).toEqual({
      preferred_version: 5,
      supported_versions: [5],
    });
    // Plan 03's audio handoff is untouched by this task.
    expect(VIVA_AUDIO_MAX_CHUNK_SAMPLES).toBe(4_096);
    expect(VIVA_AUDIO_MAX_CHUNK_BYTES).toBe(8_192);
    expect(VIVA_AUDIO_MAX_TURN_SAMPLES).toBe(1_080_000);
    expect(VIVA_AUDIO_MAX_TURN_BYTES).toBe(2_160_000);
  });

  test("selects the greatest shared version and fails closed without an overlap", () => {
    expect(negotiateVivaVoiceProtocolVersion([5], [5])).toBe(5);
    expect(negotiateVivaVoiceProtocolVersion(VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, [4, 5])).toBe(
      5,
    );
    expect(negotiateVivaVoiceProtocolVersion([4, 5], [5, 6])).toBe(5);

    for (const peerVersions of [[], [4], [6], [1, 2, 3, 4]]) {
      const rejection = captureVoiceProtocolError(() =>
        negotiateVivaVoiceProtocolVersion(VIVA_VOICE_SUPPORTED_PROTOCOL_VERSIONS, peerVersions),
      );
      expect(rejection.code).toBe("VOICE_PROTOCOL_UNSUPPORTED_VERSION");
      expect(rejection.path).toBe("$.protocol.supported_versions");
      // Diagnostics carry code and path only; never the rejected values.
      expect(rejection.message).not.toContain(JSON.stringify(peerVersions));
    }
    expect(VIVA_VOICE_DIAGNOSTIC_CODES).toContain("VOICE_PROTOCOL_UNSUPPORTED_VERSION");
  });

  test("rejects legacy v4 frames with the stable unsupported-version diagnostic", () => {
    const v4Ready = {
      type: "ready",
      version: 4,
      protocol: { preferred_version: 4, supported_versions: [4] },
      sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
      input_encoding: VIVA_VOICE_INPUT_ENCODING,
      brain: { provider: "synthetic", configured: true, selectable: true, live_runtime: false },
      store: readyV5Fixture.store,
    };
    const serverRejection = captureVoiceProtocolError(() => parseVivaServerFrame(v4Ready));
    expect(serverRejection.code).toBe("VOICE_PROTOCOL_UNSUPPORTED_VERSION");
    expect(serverRejection.path).toBe("$.version");

    const clientRejection = captureVoiceProtocolError(() =>
      parseVivaClientFrame({ type: "stop", version: 4, client_generation_id: "generation-1" }),
    );
    expect(clientRejection.code).toBe("VOICE_PROTOCOL_UNSUPPORTED_VERSION");
    expect(clientRejection.path).toBe("$.version");

    // A v5 frame whose advertisement claims another version is not silently upgraded.
    const advertisementRejection = captureVoiceProtocolError(() =>
      parseVivaServerFrame({
        ...readyV5Fixture,
        protocol: { preferred_version: 4, supported_versions: [4] },
      }),
    );
    expect(advertisementRejection.code).toBe("VOICE_PROTOCOL_UNSUPPORTED_VERSION");
  });

  test("reconstructs the canonical v5 ready fixture rather than returning the caller's object", () => {
    const source = JSON.parse(JSON.stringify(readyV5Fixture)) as Record<string, unknown>;
    const parsed = parseVivaServerFrame(source);

    expect(parsed).not.toBe(source);
    // Pinned against the independently transcribed contract values, not against the
    // fixture this very call parsed.
    expect(parsed).toEqual(CANONICAL_V5_READY);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(CANONICAL_V5_READY));
    expect(parsed).toEqual(readyV5Fixture);
    expect(Object.keys(parsed)).toEqual([
      "type",
      "version",
      "protocol",
      "sample_rate_hz",
      "input_encoding",
      "brain",
      "store",
    ]);

    if (parsed.type !== "ready") throw new Error("Expected ready frame");
    expect(parsed.protocol).toEqual({ preferred_version: 5, supported_versions: [5] });
    expect(parsed.brain).not.toBe(source.brain);
    expect(parsed.store).not.toBe(source.store);

    // Mutating the caller's object after parsing cannot reach the returned frame.
    (source.brain as Record<string, unknown>).provider = "mutated-provider";
    (source.store as Record<string, unknown>).durable = true;
    expect(parsed.brain.provider).toBe("synthetic");
    expect(parsed.store.durable).toBe(false);
  });

  test("rejects a ready frame that omits the protocol advertisement", () => {
    // `VOICE-READY-001` publishes exactly one ready representation and the strict v5
    // parser requires its advertisement; a frame without one is not v5.
    const rejection = captureVoiceProtocolError(() => parseVivaServerFrame(readyFixture));
    expect(rejection.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(rejection.path).toBe("$.protocol");
  });
});

/**
 * `VOICE-SIZE-001` / `VOICE-SIZE-002`. Plan 03's chunk and turn constants are the
 * contract; this plan adds only the derived base64 ceiling, deletes the stale v4
 * binary surface, and pins the two byte-exact size diagnostics. The aggregate turn
 * state machine stays in Plan 03's `ws.rs` assembler; nothing here duplicates it.
 */
describe("Viva voice v5 frame size contract", () => {
  test("preserves the Plan 03 audio constants and adds only the derived base64 ceiling", () => {
    expect(VIVA_VOICE_SAMPLE_RATE_HZ).toBe(24_000);
    expect(VIVA_VOICE_CHANNELS).toBe(1);
    expect(VIVA_VOICE_BYTES_PER_SAMPLE).toBe(2);
    expect(VIVA_VOICE_INPUT_ENCODING).toBe("pcm_s16le");
    expect(VIVA_VOICE_MAX_TURN_SECONDS).toBe(45);
    expect(VIVA_VOICE_MAX_TEXT_FRAME_BYTES).toBe(65_536);
    expect(VIVA_AUDIO_MAX_CHUNK_SAMPLES).toBe(4_096);
    expect(VIVA_AUDIO_MAX_CHUNK_BYTES).toBe(8_192);
    expect(VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS).toBe(10_924);
    expect(VIVA_AUDIO_MAX_TURN_SAMPLES).toBe(1_080_000);
    expect(VIVA_AUDIO_MAX_TURN_BYTES).toBe(2_160_000);

    // The literals above are the contract; these restate the derivation they encode.
    expect(VIVA_AUDIO_MAX_CHUNK_BYTES).toBe(
      VIVA_AUDIO_MAX_CHUNK_SAMPLES * VIVA_VOICE_CHANNELS * VIVA_VOICE_BYTES_PER_SAMPLE,
    );
    expect(VIVA_AUDIO_MAX_TURN_SAMPLES).toBe(
      VIVA_VOICE_MAX_TURN_SECONDS * VIVA_AUDIO_SAMPLE_RATE_HZ,
    );
    expect(VIVA_AUDIO_MAX_TURN_BYTES).toBe(
      VIVA_AUDIO_MAX_TURN_SAMPLES * VIVA_VOICE_CHANNELS * VIVA_VOICE_BYTES_PER_SAMPLE,
    );
    expect(VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS).toBe(Math.ceil(VIVA_AUDIO_MAX_CHUNK_BYTES / 3) * 4);
    expect(VIVA_AUDIO_SAMPLE_RATE_HZ).toBe(VIVA_VOICE_SAMPLE_RATE_HZ);
  });

  test("deletes the stale v4 binary frame surface from the shared contract", async () => {
    const contract = (await import("./agent-contract")) as Record<string, unknown>;
    expect("VIVA_VOICE_MAX_BINARY_FRAME_BYTES" in contract).toBe(false);

    const source = await readAgentContractSource();
    for (const stale of ["VIVA_VOICE_MAX_BINARY_FRAME_BYTES", "AgentBinary", "BinaryFrame"]) {
      expect(source).not.toContain(stale);
    }
    // Plan 10 owns browser pre-send enforcement; this module publishes no transport.
    for (const consumerOnly of ["WebSocket", "bufferedAmount", "sendFrame"]) {
      expect(source).not.toContain(consumerOnly);
    }
  });

  test("keeps the maximum chunk's 10,924 base64 characters inside the 64 KiB envelope", () => {
    const encoded = bytesToBase64(new Uint8Array(VIVA_AUDIO_MAX_CHUNK_BYTES));
    expect(encoded).toHaveLength(VIVA_AUDIO_MAX_CHUNK_BASE64_CHARS);

    const frame = {
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-fixture-audio",
      turn_id: "turn-fixture-audio",
      sequence: 2_249,
      frame: { pcm16_base64: encoded },
    };
    const wire = JSON.stringify(frame);

    expect(parseVivaClientFrameJson(wire)).toEqual(frame);
    expect(utf8ByteLength(wire)).toBeLessThan(VIVA_VOICE_MAX_TEXT_FRAME_BYTES);
  });

  test("rejects a JSON envelope above 65,536 UTF-8 bytes at $ before nested parsing", () => {
    // Measured as UTF-8 bytes, not UTF-16 code units: this string is 65,536 code
    // units and 65,537 bytes, so it must fail on size rather than on JSON shape.
    const multiByteBoundary = `é${"x".repeat(65_535)}`;
    expect(multiByteBoundary).toHaveLength(65_536);
    expect(utf8ByteLength(multiByteBoundary)).toBe(65_537);

    for (const oversized of ["x".repeat(65_537), multiByteBoundary]) {
      for (const parse of [parseVivaClientFrameJson, parseVivaServerFrameJson]) {
        const rejection = captureVoiceProtocolError(() => parse(oversized));
        expect(rejection.code).toBe("VOICE_PROTOCOL_FRAME_TOO_LARGE");
        expect(rejection.path).toBe("$");
      }
    }

    // Exactly at the cap the envelope is admitted and only then parsed, so the
    // boundary is `> 65,536` rather than `>= 65,536`.
    for (const parse of [parseVivaClientFrameJson, parseVivaServerFrameJson]) {
      const rejection = captureVoiceProtocolError(() => parse("x".repeat(65_536)));
      expect(rejection.code).toBe("VOICE_PROTOCOL_MALFORMED_JSON");
      expect(rejection.path).toBe("$");
    }
  });

  test("rejects a decoded chunk above 8,192 raw bytes at $.frame.pcm16_base64", () => {
    const chunk = (rawBytes: number) => ({
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-fixture-audio",
      turn_id: "turn-fixture-audio",
      sequence: 0,
      frame: { pcm16_base64: bytesToBase64(new Uint8Array(rawBytes)) },
    });

    expect(parseVivaClientFrame(chunk(VIVA_AUDIO_MAX_CHUNK_BYTES))).toEqual(
      chunk(VIVA_AUDIO_MAX_CHUNK_BYTES),
    );

    // 8,193 is the plan's named boundary and 8,194 keeps whole 16-bit samples, so
    // neither can be excused as an odd-byte rejection.
    for (const rawBytes of [VIVA_AUDIO_MAX_CHUNK_BYTES + 1, VIVA_AUDIO_MAX_CHUNK_BYTES + 2]) {
      const rejection = captureVoiceProtocolError(() => parseVivaClientFrame(chunk(rawBytes)));
      expect(rejection.code).toBe("VOICE_PROTOCOL_FRAME_TOO_LARGE");
      expect(rejection.path).toBe("$.frame.pcm16_base64");
      expect(rejection.message).not.toContain(chunk(rawBytes).frame.pcm16_base64);
    }
  });

  test("rejects a pcm16_base64 payload that is not canonical padded base64", () => {
    const chunk = (pcm16Base64: string) => ({
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "generation-fixture-audio",
      turn_id: "turn-fixture-audio",
      sequence: 0,
      frame: { pcm16_base64: pcm16Base64 },
    });

    // Canonical RFC 4648 base64 *with* padding is the only accepted encoding; the
    // unpadded base64url form belongs to `viva1` token segments, never to audio.
    for (const payload of ["AAB=", "AAA", "AA==A", "AA-A", "AA_A", "AA A", "AAA=\n", "", "===="]) {
      const rejection = captureVoiceProtocolError(() => parseVivaClientFrame(chunk(payload)));
      expect(rejection.code).toBe("VOICE_PROTOCOL_INVALID_FIELD");
      expect(rejection.path).toBe("$.frame.pcm16_base64");
    }

    // An odd raw byte count cannot be a whole 16-bit sample.
    const oddRejection = captureVoiceProtocolError(() => parseVivaClientFrame(chunk("AQ==")));
    expect(oddRejection.code).toBe("VOICE_PROTOCOL_INVALID_FIELD");
    expect(oddRejection.path).toBe("$.frame.pcm16_base64");

    expect(parseVivaClientFrame(chunk("AAA="))).toEqual(chunk("AAA="));
  });

  test("accepts every 45-second turn shape without inferring a chunk-count cap", () => {
    // 8,192 bytes is a maximum, never a fixed or minimum chunk size, so no chunk
    // count and no final-sequence ceiling can be derived from it.
    const turnShapes = [
      { label: "20 ms production chunks", chunkBytes: 960, chunkCount: 2_250 },
      { label: "10 ms chunks", chunkBytes: 480, chunkCount: 4_500 },
      { label: "maximum-size chunks", chunkBytes: VIVA_AUDIO_MAX_CHUNK_BYTES, chunkCount: 263 },
    ] as const;

    for (const shape of turnShapes) {
      const encoded = bytesToBase64(new Uint8Array(shape.chunkBytes));
      const aggregateBytes = shape.chunkBytes * shape.chunkCount;
      expect(aggregateBytes).toBeLessThanOrEqual(VIVA_AUDIO_MAX_TURN_BYTES);
      expect(aggregateBytes / VIVA_VOICE_BYTES_PER_SAMPLE).toBeLessThanOrEqual(
        VIVA_AUDIO_MAX_TURN_SAMPLES,
      );

      for (let sequence = 0; sequence < shape.chunkCount; sequence += 1) {
        const frame = {
          type: "audio_chunk",
          version: VIVA_VOICE_PROTOCOL_VERSION,
          client_generation_id: "generation-fixture-audio",
          turn_id: "turn-fixture-audio",
          sequence,
          frame: { pcm16_base64: encoded },
        };
        expect(parseVivaClientFrame(frame)).toEqual(frame);
      }

      const finalSequence = shape.chunkCount - 1;
      const end = {
        type: "audio_end",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: "generation-fixture-audio",
        turn_id: "turn-fixture-audio",
        final_sequence: finalSequence,
      };
      expect(parseVivaClientFrame(end)).toEqual(end);
    }

    // The 20 ms production turn ends at sequence 2,249; smaller valid chunks push
    // the final sequence past it while the aggregate bounds stay identical.
    expect(2_250 * 960).toBe(VIVA_AUDIO_MAX_TURN_BYTES);
    expect(4_500 - 1).toBeGreaterThan(2_250 - 1);
    expect(4_500 * 480).toBe(VIVA_AUDIO_MAX_TURN_BYTES);

    // Only per-chunk and aggregate bounds reject; there is no count ceiling.
    expect(263 * VIVA_AUDIO_MAX_CHUNK_BYTES).toBeLessThanOrEqual(VIVA_AUDIO_MAX_TURN_BYTES);
    expect(264 * VIVA_AUDIO_MAX_CHUNK_BYTES).toBeGreaterThan(VIVA_AUDIO_MAX_TURN_BYTES);
    expect(VIVA_AUDIO_MAX_TURN_BYTES + 2).toBeGreaterThan(VIVA_AUDIO_MAX_TURN_BYTES);
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
    expect(Object.keys(sessionTokenVectorClaims("VOICE-TOKEN-REJECT-UNKNOWN-CLAIM"))).toContain(
      "role",
    );
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

/**
 * `VOICE-AUTH-001` / `VOICE-REFRESH-001` / `VOICE-AUTHORITY-001`. Every v5 client frame
 * is generation-bound, the first application frame carries the signed credential at the
 * top level, in-socket refresh is context-only, and the browser-sendable union is
 * exactly seven variants with no tool authority anywhere in it.
 */
const CANONICAL_SIGNED_SESSION_CONFIG = {
  type: "session_config",
  version: 5,
  client_generation_id: "viva-session-bootstrap-1-fixture",
  session_token: CANONICAL_FIXTURE_SESSION_TOKEN,
  session: {
    session_id: "fixture-session",
    user_id: "fixture-user",
    study_set_id: "fixture-study-set",
    mode: "quiz",
    source_context: [],
    active_concepts: [],
  },
} as const;

const CANONICAL_SESSION_REFRESH = {
  type: "session_refresh",
  version: 5,
  client_generation_id: "viva-session-bootstrap-1-fixture",
  context: {
    mode: "quiz",
    initial_goal: "Review the fixture source.",
  },
} as const;

/** One valid frame per browser-authorized variant, all on the same generation. */
function browserClientFrameSamples(): Record<string, Record<string, unknown>> {
  return {
    session_config: structuredClone(CANONICAL_SIGNED_SESSION_CONFIG) as Record<string, unknown>,
    session_refresh: structuredClone(CANONICAL_SESSION_REFRESH) as Record<string, unknown>,
    audio_chunk: {
      type: "audio_chunk",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "viva-session-bootstrap-1-fixture",
      turn_id: "turn-1",
      sequence: 0,
      frame: { pcm16_base64: "AQIDBA==" },
    },
    audio_end: {
      type: "audio_end",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "viva-session-bootstrap-1-fixture",
      turn_id: "turn-1",
      final_sequence: 0,
    },
    turn_intent: {
      type: "turn_intent",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "viva-session-bootstrap-1-fixture",
      turn_id: "turn-1",
      intent: { kind: "answer_text", text: "NADH donates electrons." },
    },
    cancel: {
      type: "cancel",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "viva-session-bootstrap-1-fixture",
      turn_id: "turn-1",
    },
    stop: {
      type: "stop",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "viva-session-bootstrap-1-fixture",
    },
  };
}

describe("Viva voice v5 signed first frame, generation identity, and browser authority", () => {
  test("pins the canonical signed first frame byte-for-byte", () => {
    expect(signedSessionConfigFixture).toEqual(CANONICAL_SIGNED_SESSION_CONFIG);
    expect(JSON.stringify(signedSessionConfigFixture)).toBe(
      JSON.stringify(CANONICAL_SIGNED_SESSION_CONFIG),
    );
    expect(parseVivaClientFrame(signedSessionConfigFixture)).toEqual(
      CANONICAL_SIGNED_SESSION_CONFIG,
    );
    // The credential is the same fixture-only string the shared token vectors pin, so
    // Rust, Node, and the wire fixture cannot drift apart.
    expect(signedSessionConfigFixture.session_token).toBe(
      sessionTokenVectorCase("VOICE-TOKEN-VALID-CANONICAL").token,
    );
  });

  test("pins the canonical branch-neutral context-only refresh frame byte-for-byte", () => {
    expect(sessionRefreshFixture).toEqual(CANONICAL_SESSION_REFRESH);
    expect(JSON.stringify(sessionRefreshFixture)).toBe(JSON.stringify(CANONICAL_SESSION_REFRESH));
    expect(parseVivaClientFrame(sessionRefreshFixture)).toEqual(CANONICAL_SESSION_REFRESH);
  });

  test("requires a non-empty client_generation_id on every browser-sendable variant", () => {
    const samples = browserClientFrameSamples();
    expect(Object.keys(samples)).toEqual([...VIVA_BROWSER_CLIENT_FRAME_TYPES]);

    for (const [type, frame] of Object.entries(samples)) {
      expect(parseVivaClientFrame(frame)).toEqual(frame);

      const { client_generation_id: _absent, ...withoutGeneration } = frame;
      const missing = captureVoiceProtocolError(() => parseVivaClientFrame(withoutGeneration));
      expect({ type, code: missing.code, path: missing.path }).toEqual({
        type,
        code: "VOICE_PROTOCOL_MISSING_FIELD",
        path: "$.client_generation_id",
      });

      for (const blank of ["", "   "]) {
        const empty = captureVoiceProtocolError(() =>
          parseVivaClientFrame({ ...frame, client_generation_id: blank }),
        );
        expect({ type, code: empty.code, path: empty.path }).toEqual({
          type,
          code: "VOICE_PROTOCOL_INVALID_FIELD",
          path: "$.client_generation_id",
        });
      }
    }
  });

  test("requires the signed credential at the frame top level and forbids a nested one", () => {
    const { session_token: _absent, ...withoutToken } = CANONICAL_SIGNED_SESSION_CONFIG;
    const missing = captureVoiceProtocolError(() => parseVivaClientFrame(withoutToken));
    expect(missing.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(missing.path).toBe("$.session_token");

    for (const blank of ["", "   "]) {
      const empty = captureVoiceProtocolError(() =>
        parseVivaClientFrame({ ...CANONICAL_SIGNED_SESSION_CONFIG, session_token: blank }),
      );
      expect(empty.code).toBe("VOICE_PROTOCOL_INVALID_FIELD");
      expect(empty.path).toBe("$.session_token");
    }

    const nested = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        ...CANONICAL_SIGNED_SESSION_CONFIG,
        session: {
          ...CANONICAL_SIGNED_SESSION_CONFIG.session,
          session_token: CANONICAL_FIXTURE_SESSION_TOKEN,
        },
      }),
    );
    expect(nested.code).toBe("VOICE_PROTOCOL_FORBIDDEN_AUTHORITY");
    expect(nested.path).toBe("$.session.session_token");
  });

  test("keeps in-socket refresh context-only and free of credentials or identity", () => {
    for (const forbidden of [
      "session_token",
      "user_id",
      "study_set_id",
      "session_id",
      "source_context",
      "active_concepts",
    ]) {
      const rejection = captureVoiceProtocolError(() =>
        parseVivaClientFrame({
          ...CANONICAL_SESSION_REFRESH,
          context: { ...CANONICAL_SESSION_REFRESH.context, [forbidden]: "fixture-value" },
        }),
      );
      expect({ forbidden, code: rejection.code, path: rejection.path }).toEqual({
        forbidden,
        code: "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
        path: `$.context.${forbidden}`,
      });
    }

    const unknown = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        ...CANONICAL_SESSION_REFRESH,
        context: { ...CANONICAL_SESSION_REFRESH.context, tenant: "fixture-tenant" },
      }),
    );
    expect(unknown.code).toBe("VOICE_PROTOCOL_UNKNOWN_FIELD");
    expect(unknown.path).toBe("$.context.tenant");

    const empty = captureVoiceProtocolError(() =>
      parseVivaClientFrame({ ...CANONICAL_SESSION_REFRESH, context: {} }),
    );
    expect(empty.code).toBe("VOICE_PROTOCOL_MISSING_FIELD");
    expect(empty.path).toBe("$.context");

    // Either key alone is a complete context.
    for (const context of [{ mode: "quiz" }, { initial_goal: "Review the fixture source." }]) {
      const frame = { ...CANONICAL_SESSION_REFRESH, context };
      expect(parseVivaClientFrame(frame)).toEqual(frame);
    }

    for (const goal of ["", "   ", "g".repeat(513)]) {
      const rejection = captureVoiceProtocolError(() =>
        parseVivaClientFrame({ ...CANONICAL_SESSION_REFRESH, context: { initial_goal: goal } }),
      );
      expect(rejection.code).toBe("VOICE_PROTOCOL_INVALID_FIELD");
      expect(rejection.path).toBe("$.context.initial_goal");
    }
    const atLimit = {
      ...CANONICAL_SESSION_REFRESH,
      context: { initial_goal: "g".repeat(512) },
    };
    expect(parseVivaClientFrame(atLimit)).toEqual(atLimit);
  });

  test("keeps the refresh policy branch out of the parser", async () => {
    // Parsing a well-formed refresh does not authorize or apply it; Plan 08 owns the
    // selected D-03 branch and its recoverable denial event. This module carries
    // neither the denial code nor any branch switch.
    const source = await readAgentContractSource();
    expect(source).not.toContain("REFRESH_POLICY");
    expect(source).not.toContain("POLICY_DENIED");

    // The parsed context is returned intact, never rewritten into a denial.
    expect(parseVivaClientFrame(sessionRefreshFixture)).toEqual(CANONICAL_SESSION_REFRESH);
  });

  test("exports exactly the seven browser-authorized variants and no tool authority", async () => {
    expect([...VIVA_BROWSER_CLIENT_FRAME_TYPES]).toEqual([
      "session_config",
      "session_refresh",
      "audio_chunk",
      "audio_end",
      "turn_intent",
      "cancel",
      "stop",
    ]);

    const contract = (await import("./agent-contract")) as Record<string, unknown>;
    expect("AgentToolProposal" in contract).toBe(false);
    expect("AgentToolResult" in contract).toBe(false);
    const source = await readAgentContractSource();
    expect(source).not.toContain("AgentToolProposal");
    expect(source).not.toContain("AgentToolResult");

    const forged = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        type: "tool_result",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: "viva-session-bootstrap-1-fixture",
        result: { proposal: { name: "write_review_state", arguments: {} }, result: {} },
      }),
    );
    expect(forged.code).toBe("VOICE_PROTOCOL_FORBIDDEN_AUTHORITY");
    expect(forged.path).toBe("$.type");

    // There is no v5 plain text frame; it is an unknown frame, not a tool authority.
    const plainText = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        type: "text",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: "viva-session-bootstrap-1-fixture",
        text: "NADH donates electrons.",
      }),
    );
    expect(plainText.code).toBe("VOICE_PROTOCOL_UNKNOWN_FRAME");
    expect(plainText.path).toBe("$.type");
  });

  test("types answer text and citation challenge so neither can cross-grade", () => {
    const challenge = {
      type: "turn_intent",
      version: VIVA_VOICE_PROTOCOL_VERSION,
      client_generation_id: "viva-session-bootstrap-1-fixture",
      turn_id: "turn-2",
      intent: { kind: "citation_challenge", response_id: "response-2", source_id: "src-lecture-5" },
    };
    expect(parseVivaClientFrame(challenge)).toEqual(challenge);

    // A citation challenge cannot smuggle answer text, and answer text cannot smuggle
    // citation identity.
    const crossGraded = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        ...challenge,
        intent: { ...challenge.intent, text: "NADH donates electrons." },
      }),
    );
    expect(crossGraded.code).toBe("VOICE_PROTOCOL_UNKNOWN_FIELD");
    expect(crossGraded.path).toBe("$.intent.text");

    const forgedAnswer = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        ...challenge,
        intent: { kind: "answer_text", text: "NADH donates electrons.", source_id: "src-1" },
      }),
    );
    expect(forgedAnswer.code).toBe("VOICE_PROTOCOL_UNKNOWN_FIELD");
    expect(forgedAnswer.path).toBe("$.intent.source_id");

    for (const badId of ["", "  ", ".leading-dot", "a".repeat(129), "has space"]) {
      const rejection = captureVoiceProtocolError(() =>
        parseVivaClientFrame({
          ...challenge,
          intent: { ...challenge.intent, source_id: badId },
        }),
      );
      expect(rejection.code).toBe("VOICE_PROTOCOL_INVALID_FIELD");
      expect(rejection.path).toBe("$.intent.source_id");
    }
  });

  test("keeps the fake credential out of every diagnostic", () => {
    const rejections = [
      captureVoiceProtocolError(() =>
        parseVivaClientFrame({ ...CANONICAL_SIGNED_SESSION_CONFIG, version: 4 }),
      ),
      captureVoiceProtocolError(() =>
        parseVivaClientFrame({
          ...CANONICAL_SIGNED_SESSION_CONFIG,
          session: { ...CANONICAL_SIGNED_SESSION_CONFIG.session, session_id: "" },
        }),
      ),
      captureVoiceProtocolError(() =>
        parseVivaClientFrameJson(JSON.stringify({ ...CANONICAL_SIGNED_SESSION_CONFIG, type: 7 })),
      ),
    ];

    for (const rejection of rejections) {
      const rendered = `${rejection.name} ${rejection.code} ${rejection.path} ${rejection.message}`;
      expect(rendered).not.toContain("viva1");
      expect(rendered).not.toContain("fixture-user");
      expect(rendered).not.toContain("fixture-session");
      expect(rendered.toLowerCase()).not.toContain("bearer");
    }
  });
});

/**
 * `VOICE-DIAGNOSTIC-001` / `VOICE-RUNTIME-001` / `VOICE-DIFFERENTIAL-001`. Both runners
 * execute every case in file order with no id filter, assert the exact accept/reject and
 * the exact code/path, and prove no diagnostic ever echoes the rejected input.
 */
type DifferentialCase = {
  id: string;
  wire_json: string;
  valid: boolean;
  diagnostic_code: string | null;
  path: string | null;
};

type DifferentialCaseFile = {
  schema: string;
  protocol_version: number;
  cases: DifferentialCase[];
};

const clientDifferentialCases = clientDifferentialFixture as unknown as DifferentialCaseFile;
const serverDifferentialCases = serverDifferentialFixture as unknown as DifferentialCaseFile;

/** Substrings no diagnostic may ever carry: credentials, learner facts, raw JSON. */
const DIAGNOSTIC_LEAK_NEEDLES = [
  "viva1",
  "fixture-user",
  "fixture-study-set",
  "fixture-session",
  "NADH",
  "AQIDBA==",
  "{",
  '"',
];

function runDifferentialCases(
  file: DifferentialCaseFile,
  parse: (wireJson: string) => unknown,
): number {
  expect(file.schema).toBe("viva.voice-differential-cases.v1");
  expect(file.protocol_version).toBe(VIVA_VOICE_PROTOCOL_VERSION);
  expect(file.cases.length).toBeGreaterThan(0);

  const seen = new Set<string>();
  for (const differentialCase of file.cases) {
    const id = differentialCase.id;
    expect({ id, duplicate: seen.has(id) }).toEqual({ id, duplicate: false });
    seen.add(id);

    if (differentialCase.valid) {
      expect({ id, code: differentialCase.diagnostic_code, path: differentialCase.path }).toEqual({
        id,
        code: null,
        path: null,
      });
      // A valid case reserializes byte for byte: the parser reconstructs the frame in
      // wire order rather than handing back the caller's object.
      expect({ id, wire: JSON.stringify(parse(differentialCase.wire_json)) }).toEqual({
        id,
        wire: differentialCase.wire_json,
      });
      continue;
    }

    expect({ id, code: differentialCase.diagnostic_code === null }).toEqual({ id, code: false });
    const rejection = captureVoiceProtocolError(() => parse(differentialCase.wire_json));
    expect({ id, code: rejection.code, path: rejection.path }).toEqual({
      id,
      code: differentialCase.diagnostic_code,
      path: differentialCase.path,
    });
    expect(VIVA_VOICE_DIAGNOSTIC_CODES).toContain(rejection.code);

    const rendered = `${rejection.name} ${rejection.code} ${rejection.path} ${rejection.message}`;
    for (const needle of DIAGNOSTIC_LEAK_NEEDLES) {
      expect({ id, needle, leaked: rendered.includes(needle) }).toEqual({
        id,
        needle,
        leaked: false,
      });
    }
  }
  return file.cases.length;
}

/** Every nested object boundary of a parsed wire frame, root first. */
function objectBoundaries(value: unknown, path: string[] = []): string[][] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => objectBoundaries(entry, [...path, String(index)]));
  }
  return [
    path,
    ...Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      objectBoundaries(entry, [...path, key]),
    ),
  ];
}

/** Replaces every scalar leaf of a mutable tree so shared references become visible. */
function scrambleLeavesInPlace(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry && typeof entry === "object") {
      scrambleLeavesInPlace(entry);
      continue;
    }
    if (typeof entry === "string") record[key] = "VOICE_scrambled_fixture_value";
    else if (typeof entry === "number") record[key] = 999_999;
    else if (typeof entry === "boolean") record[key] = !entry;
    else record[key] = "VOICE_scrambled_fixture_value";
  }
}

function withInjectedValue(source: unknown, path: string[], key: string, value: unknown): unknown {
  const clone = structuredClone(source) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const step of path) {
    cursor = cursor[step] as Record<string, unknown>;
  }
  cursor[key] = value;
  return clone;
}

function withoutKey(source: unknown, path: string[], key: string): unknown {
  const clone = structuredClone(source) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const step of path) {
    cursor = cursor[step] as Record<string, unknown>;
  }
  delete cursor[key];
  return clone;
}

describe("Viva voice v5 differential parsing", () => {
  test("runs every client differential case with no id filter", () => {
    const executed = runDifferentialCases(clientDifferentialCases, parseVivaClientFrameJson);
    expect(executed).toBe(clientDifferentialCases.cases.length);
  });

  test("runs every server differential case with no id filter", () => {
    const executed = runDifferentialCases(serverDifferentialCases, parseVivaServerFrameJson);
    expect(executed).toBe(serverDifferentialCases.cases.length);
  });

  test("covers every browser-sendable variant and every server frame and event", () => {
    const validClientTypes = clientDifferentialCases.cases
      .filter((differentialCase) => differentialCase.valid)
      .map((differentialCase) => (JSON.parse(differentialCase.wire_json) as { type: string }).type);
    for (const frameType of VIVA_BROWSER_CLIENT_FRAME_TYPES) {
      expect(validClientTypes).toContain(frameType);
    }

    const validServer = serverDifferentialCases.cases
      .filter((differentialCase) => differentialCase.valid)
      .map((differentialCase) => JSON.parse(differentialCase.wire_json) as Record<string, unknown>);
    for (const frameType of ["ready", "audio_turn_accepted", "event", "error"]) {
      expect(validServer.map((frame) => frame.type)).toContain(frameType);
    }
    const eventTypes = validServer.flatMap((frame) =>
      frame.type === "event" ? [(frame.event as { type: string }).type] : [],
    );
    for (const eventType of [
      "session_phase",
      "question_started",
      "transcript_delta",
      "transcript_final",
      "answer_evaluated",
      "source_reference",
      "concept_status",
      "manuscript_intent",
      "recap_ready",
      "audio_delta",
      "cancellation",
      "structured_error",
    ]) {
      expect(eventTypes).toContain(eventType);
    }
  });

  test("pins the exact authority and size differential rows", () => {
    const rows = new Map(
      clientDifferentialCases.cases.map((differentialCase) => [
        differentialCase.id,
        { code: differentialCase.diagnostic_code, path: differentialCase.path },
      ]),
    );
    expect(rows.get("VOICE-CLIENT-REJECT-FORGED-TOOL-RESULT")).toEqual({
      code: "VOICE_PROTOCOL_FORBIDDEN_AUTHORITY",
      path: "$.type",
    });
    expect(rows.get("VOICE-CLIENT-REJECT-TEXT-FRAME-65537")).toEqual({
      code: "VOICE_PROTOCOL_FRAME_TOO_LARGE",
      path: "$",
    });
    expect(rows.get("VOICE-CLIENT-REJECT-AUDIO-CHUNK-8193")).toEqual({
      code: "VOICE_PROTOCOL_FRAME_TOO_LARGE",
      path: "$.frame.pcm16_base64",
    });
    // `VOICE-CLIENT-REJECT-TURN-2160002` is a stateful sequence row and lives in
    // `audio-turn-lifecycle.json`, never in a single-frame parser file.
    expect(rows.has("VOICE-CLIENT-REJECT-TURN-2160002")).toBe(false);
    expect(
      clientDifferentialCases.cases.some(
        (differentialCase) => differentialCase.diagnostic_code === "VOICE_PROTOCOL_TURN_TOO_LARGE",
      ),
    ).toBe(false);
  });

  test("reconstructs nested server objects instead of returning the caller's object", () => {
    const source = JSON.parse(JSON.stringify(readyV5Fixture)) as Record<string, unknown>;
    const parsed = parseVivaServerFrame(source);

    expect(parsed).not.toBe(source);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(CANONICAL_V5_READY));
    if (parsed.type !== "ready") throw new Error("Expected ready frame");
    expect(parsed.brain).not.toBe(source.brain);
    expect(parsed.store).not.toBe(source.store);
    expect(parsed.protocol).not.toBe(source.protocol);

    (source.brain as Record<string, unknown>).provider = "mutated-provider";
    (source.store as Record<string, unknown>).durable = true;
    (source.protocol as Record<string, unknown>).preferred_version = 4;
    expect(parsed.brain.provider).toBe("synthetic");
    expect(parsed.store.durable).toBe(false);
    expect(parsed.protocol.preferred_version).toBe(5);
  });

  test("shares no mutable node with the caller for any valid case", () => {
    // Scrambling every leaf of the caller's object after parsing must not move a byte of
    // the returned frame: a parser that handed back the caller's object would fail here.
    for (const [file, parse] of [
      [clientDifferentialCases, parseVivaClientFrame] as const,
      [serverDifferentialCases, parseVivaServerFrame] as const,
    ]) {
      for (const differentialCase of file.cases) {
        if (!differentialCase.valid) continue;
        const source = JSON.parse(differentialCase.wire_json) as unknown;
        const parsed = parse(source);
        const before = JSON.stringify(parsed);
        expect({ id: differentialCase.id, same: (parsed as unknown) === source }).toEqual({
          id: differentialCase.id,
          same: false,
        });

        scrambleLeavesInPlace(source);
        expect({ id: differentialCase.id, wire: JSON.stringify(parsed) }).toEqual({
          id: differentialCase.id,
          wire: before,
        });
      }
    }
  });

  test("rejects an injected unknown field at every object boundary of every valid case", () => {
    for (const [file, parse] of [
      [clientDifferentialCases, parseVivaClientFrame] as const,
      [serverDifferentialCases, parseVivaServerFrame] as const,
    ]) {
      for (const differentialCase of file.cases) {
        if (!differentialCase.valid) continue;
        const source = JSON.parse(differentialCase.wire_json) as unknown;
        const boundaries = objectBoundaries(source);
        expect({ id: differentialCase.id, boundaries: boundaries.length }).not.toEqual({
          id: differentialCase.id,
          boundaries: 0,
        });
        for (const boundary of boundaries) {
          const mutated = withInjectedValue(source, boundary, "VOICE_unknown_fixture_field", true);
          const rejection = captureVoiceProtocolError(() => parse(mutated));
          expect({
            id: differentialCase.id,
            boundary: boundary.join("."),
            code: rejection.code,
            tail: rejection.path.endsWith("VOICE_unknown_fixture_field"),
          }).toEqual({
            id: differentialCase.id,
            boundary: boundary.join("."),
            code: "VOICE_PROTOCOL_UNKNOWN_FIELD",
            tail: true,
          });
        }
      }
    }
  });

  /**
   * The exact optional keys the v5 contract allows, qualified by the case that carries
   * them. Deleting one of these must still parse; deleting anything else must not.
   */
  const OPTIONAL_WIRE_PATHS = new Set([
    "VOICE-CLIENT-VALID-SESSION-CONFIG|session.mode",
    "VOICE-CLIENT-VALID-SESSION-REFRESH|context.mode",
    "VOICE-CLIENT-VALID-SESSION-REFRESH|context.initial_goal",
    "VOICE-CLIENT-VALID-CANCEL-SCOPED|.turn_id",
    "VOICE-SERVER-VALID-EVENT-SESSION-PHASE-TERMINAL|event.terminal_reason",
    "VOICE-SERVER-VALID-EVENT-RECAP-READY-PARTIAL|event.partial_reason",
  ]);

  test("rejects v4, future versions, deleted keys, and flipped scalar types", () => {
    for (const [file, parse] of [
      [clientDifferentialCases, parseVivaClientFrame] as const,
      [serverDifferentialCases, parseVivaServerFrame] as const,
    ]) {
      for (const differentialCase of file.cases) {
        if (!differentialCase.valid) continue;
        const source = JSON.parse(differentialCase.wire_json) as Record<string, unknown>;

        for (const version of [4, 6]) {
          const rejection = captureVoiceProtocolError(() => parse({ ...source, version }));
          expect({
            id: differentialCase.id,
            version,
            code: rejection.code,
            path: rejection.path,
          }).toEqual({
            id: differentialCase.id,
            version,
            code: "VOICE_PROTOCOL_UNSUPPORTED_VERSION",
            path: "$.version",
          });
        }

        const withoutType = captureVoiceProtocolError(() => parse(withoutKey(source, [], "type")));
        expect({ id: differentialCase.id, code: withoutType.code, path: withoutType.path }).toEqual(
          {
            id: differentialCase.id,
            code: "VOICE_PROTOCOL_UNKNOWN_FRAME",
            path: "$.type",
          },
        );

        for (const boundary of objectBoundaries(source)) {
          const container = boundary.reduce<Record<string, unknown>>(
            (cursor, step) => cursor[step] as Record<string, unknown>,
            source,
          );
          for (const key of Object.keys(container)) {
            if (boundary.length === 0 && (key === "type" || key === "version")) continue;
            const keyPath = `${boundary.join(".")}.${key}`;
            const withoutIt = withoutKey(source, boundary, key);
            if (OPTIONAL_WIRE_PATHS.has(`${differentialCase.id}|${keyPath}`)) {
              // An optional key: the frame stays valid without it.
              expect({
                id: differentialCase.id,
                keyPath,
                parsed: parse(withoutIt) !== undefined,
              }).toEqual({ id: differentialCase.id, keyPath, parsed: true });
            } else {
              const rejection = captureVoiceProtocolError(() => parse(withoutIt));
              expect({
                id: differentialCase.id,
                key: keyPath,
                inVocabulary: VIVA_VOICE_DIAGNOSTIC_CODES.includes(rejection.code),
              }).toEqual({
                id: differentialCase.id,
                key: keyPath,
                inVocabulary: true,
              });
            }

            const flipped = captureVoiceProtocolError(() =>
              parse(withInjectedValue(source, boundary, key, { flipped: true })),
            );
            expect({
              id: differentialCase.id,
              key: `${boundary.join(".")}.${key}`,
              flippedInVocabulary: VIVA_VOICE_DIAGNOSTIC_CODES.includes(flipped.code),
            }).toEqual({
              id: differentialCase.id,
              key: `${boundary.join(".")}.${key}`,
              flippedInVocabulary: true,
            });
          }
        }
      }
    }
  });

  test("rejects a padded token segment and a two-byte-over chunk", () => {
    const segments = CANONICAL_FIXTURE_SESSION_TOKEN.split(".");
    for (const index of [1, 2]) {
      const padded = [...segments];
      padded[index] = `${padded[index]}=`;
      const rejection = captureVoiceProtocolError(() =>
        parseVivaClientFrame({
          ...CANONICAL_SIGNED_SESSION_CONFIG,
          session_token: padded.join("."),
        }),
      );
      expect(rejection.code).toBe("VOICE_PROTOCOL_NONCANONICAL_BASE64URL");
      expect(rejection.path).toBe("$.session_token");
    }

    const oversized = captureVoiceProtocolError(() =>
      parseVivaClientFrame({
        type: "audio_chunk",
        version: VIVA_VOICE_PROTOCOL_VERSION,
        client_generation_id: "viva-session-bootstrap-1-fixture",
        turn_id: "turn-1",
        sequence: 0,
        frame: {
          pcm16_base64: bytesToBase64(new Uint8Array(VIVA_AUDIO_MAX_CHUNK_BYTES + 2)),
        },
      }),
    );
    expect(oversized.code).toBe("VOICE_PROTOCOL_FRAME_TOO_LARGE");
    expect(oversized.path).toBe("$.frame.pcm16_base64");
  });

  test("keeps agent-contract.ts self-contained pure ESM", async () => {
    const source = await readAgentContractSource();

    // `VOICE-RUNTIME-001`: no imports at all, so no Node builtin, no package root, and
    // no fixture can reach this module.
    expect(/^\s*import\s/m.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
    for (const host of [
      "node:",
      "process.env",
      "readFileSync",
      "fs/promises",
      "./index",
      "fixtures/",
    ]) {
      expect(source).not.toContain(host);
    }
    // Browser-only globals, matched at a token boundary so wire field names such as
    // `document_id` are not false positives.
    for (const global of [
      /\bglobalThis\b/,
      /\bwindow\s*\./,
      /\bdocument\s*\./,
      /\bWebSocket\b/,
      /\blocalStorage\b/,
    ]) {
      expect(global.test(source)).toBe(false);
    }
  });
});

function captureVoiceProtocolError(run: () => unknown): VivaVoiceProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof VivaVoiceProtocolError) return error;
    throw error;
  }
  throw new Error("Expected a redaction-safe VivaVoiceProtocolError");
}

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

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Reads this plan's behavioural source as text so the size and purity fences can be
 * asserted from inside the suite. Only the test reaches the filesystem;
 * `agent-contract.ts` itself stays pure ESM with no host access (`VOICE-RUNTIME-001`).
 */
async function readAgentContractSource(): Promise<string> {
  const host = globalThis as unknown as {
    Bun: { file(path: string): { text(): Promise<string> } };
  };
  return host.Bun.file(new URL("./agent-contract.ts", import.meta.url).pathname).text();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Reads `active_concepts` out of the frozen unversioned corpus structurally. That corpus
 * is v4 client wire shape and is deliberately rejected by the v5 parser, so this helper
 * never routes it through `parseVivaClientFrame`. Retired with the corpus in Task 9.
 */
function legacyActiveConceptIds(fixture: { client: unknown[] }): string[] {
  return fixture.client.flatMap((frame) => {
    if (!frame || typeof frame !== "object") return [];
    const record = frame as Record<string, unknown>;
    if (record.type !== "session_config") return [];
    const session = record.session as { active_concepts?: unknown } | undefined;
    return Array.isArray(session?.active_concepts) ? (session.active_concepts as string[]) : [];
  });
}

/**
 * Reads `concept_status` ids out of the frozen unversioned corpus structurally, for the
 * same reason `legacyActiveConceptIds` does: that corpus is pre-v5 and the strict parser
 * rejects it. Retired with the corpus in Task 9 Step 6.
 */
function conceptStatusIdsFromFixture(fixture: { server: unknown[] }): string[] {
  return fixture.server.flatMap((frame) => {
    if (!frame || typeof frame !== "object") return [];
    const record = frame as { type?: unknown; event?: { type?: unknown; concept_id?: unknown } };
    if (record.type !== "event" || record.event?.type !== "concept_status") return [];
    return typeof record.event.concept_id === "string" ? [record.event.concept_id] : [];
  });
}
