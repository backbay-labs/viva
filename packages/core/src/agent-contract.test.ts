import { describe, expect, test } from "bun:test";
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
import {
  type AgentSessionConfig,
  audioClientFrame,
  parseVivaClientFrame,
  parseVivaServerFrame,
  sessionConfigFrame,
  VIVA_VOICE_INPUT_ENCODING,
  VIVA_VOICE_PROTOCOL_VERSION,
  VIVA_VOICE_SAMPLE_RATE_HZ,
} from "./agent-contract";
import { seedStudySets } from "./index";

describe("Viva voice agent contract", () => {
  test("uses protocol v3 because ready frames carry required provider/store nonce readiness", () => {
    expect(VIVA_VOICE_PROTOCOL_VERSION).toBe(3);
    expect(() =>
      parseVivaServerFrame({
        type: "ready",
        version: 2,
        sample_rate_hz: VIVA_VOICE_SAMPLE_RATE_HZ,
        input_encoding: VIVA_VOICE_INPUT_ENCODING,
      }),
    ).toThrow("Unsupported Viva voice protocol version");
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

  test("builds and parses shared audio frame fixture", () => {
    const frame = audioClientFrame("AQIDBA==");
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
    expect(clientFrames[1]?.type).toBe("audio");
    expect(serverFrames[0]?.type).toBe("ready");
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
    expect(fakeEvidencePackFixture.server_frame_count).toBe(fakeSessionFixture.server.length - 1);
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
