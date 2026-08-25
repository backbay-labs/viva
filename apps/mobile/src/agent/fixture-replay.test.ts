import { describe, expect, test } from "bun:test";
import { parseVivaServerFrame } from "@viva/core";
import {
  deriveVivaAgentUiState,
  initialVivaAgentSessionState,
  vivaAgentReducer,
} from "@/agent/shared-web";
import fakeCartesiaGeminiStudySession from "../../../../agent/fixtures/voice-protocol/fake-cartesia-gemini-study-session.json";
import syntheticStudySession from "../../../../agent/fixtures/voice-protocol/synthetic-study-session.json";

function replay(fixture: { server: unknown[] }) {
  let state = initialVivaAgentSessionState();
  for (const frame of fixture.server) {
    state = vivaAgentReducer(state, parseVivaServerFrame(frame));
  }
  return { derived: deriveVivaAgentUiState(state), state };
}

describe("mobile pipeline replays the canonical session fixtures", () => {
  test("synthetic study session reaches a grounded recap", () => {
    const { derived, state } = replay(syntheticStudySession);

    expect(derived.phase).toBe("recap");
    expect(derived.question).toEqual({
      expectedTerms: [
        "electron donor",
        "electron transport chain",
        "proton gradient",
        "ATP synthase",
      ],
      followUp: "Now connect that electron flow to ATP synthase in one precise sentence.",
      id: "q-oxidative-phosphorylation-nadh",
      prompt: "Explain the role of NADH in oxidative phosphorylation.",
      source: {
        confidence: "high",
        documentId: "lec-5",
        excerpt:
          "NADH donates high-energy electrons to the electron transport chain. Electron flow pumps protons across the inner mitochondrial membrane, creating the gradient that drives ATP synthase.",
        label: "Lecture 5 · Slide 18",
        retrievalReason: "server fixture source for oxidative phosphorylation",
        sourceId: "src-lecture-5-slide-18",
        span: "slide:18",
      },
    });
    expect(derived.transcript).toBe("NADH gives electrons to the electron transport chain.");
    expect(derived.finalTranscript).toBe("NADH gives electrons to the electron transport chain.");
    expect(derived.transcriptConfidence).toBe(0.78);
    expect(derived.evaluation?.label).toBe("partially correct");
    expect(derived.evaluation?.source.sourceId).toBe("src-lecture-5-slide-18");
    expect(derived.currentSource?.sourceId).toBe("src-lecture-5-slide-18");
    expect(derived.currentConceptStatus).toBe("shaky");
    expect(derived.conceptStatuses).toEqual({ nadh: "shaky" });
    expect(derived.manuscriptIntents).toEqual([
      { type: "scene_intent", register: "examining", emphasis: "measured" },
      {
        type: "marginalia_intent",
        marginalia_id: "source-folio",
        anchor_entity_id: "src-lecture-5-slide-18",
        register: "sourcing",
        emphasis: "measured",
      },
      {
        type: "entity_intent",
        entity_id: "nadh",
        entity_kind: "concept",
        register: "correcting",
        emphasis: "marked",
      },
    ]);
    expect(derived.sources).toHaveLength(1);
    expect(derived.recap?.headline).toBe("Oxidative phosphorylation is getting stronger.");
    expect(derived.recap?.strongConcepts).toEqual(["NADH", "electron transport chain"]);
    expect(derived.recap?.shakyConcepts).toEqual(["proton gradient"]);
    expect(derived.recap?.reviewLater).toEqual(["ATP synthase"]);
    expect(derived.errors).toEqual([]);
    expect(derived.canSubmitAnswer).toBe(true);
    expect(state.cancelledResponseIds).toEqual(["response-2"]);
  });

  test("fake Cartesia/Gemini study session retains examiner audio", () => {
    const { derived, state } = replay(fakeCartesiaGeminiStudySession);

    expect(derived.phase).toBe("recap");
    expect(derived.question?.prompt).toBe("Explain the role of NADH in oxidative phosphorylation.");
    expect(derived.transcript).toBe("NADH donates electrons to the electron transport chain.");
    expect(derived.transcriptConfidence).toBe(0.91);
    expect(derived.evaluation?.label).toBe("vague");
    expect(derived.currentConceptStatus).toBe("strong");
    expect(derived.conceptStatuses).toEqual({ "oxidative-phosphorylation": "strong" });
    expect(derived.recap?.headline).toBe(
      "Explain the role of NADH in oxidative phosphorylation. is ready for another pass.",
    );
    expect(derived.errors).toEqual([]);
    expect(derived.canSubmitAnswer).toBe(true);

    expect(state.audio).toHaveLength(1);
    expect(state.audio[0]).toEqual({
      responseId: "response-1",
      frame: { pcm16_base64: "AQIDBA==" },
    });
    expect(state.cancelledResponseIds).toEqual(["response-2"]);
  });
});
