import { describe, expect, test } from "bun:test";
import {
  type AgentStudySourceReference,
  parseVivaServerFrame,
  type StudySet,
  seedStudySets,
} from "@viva/core";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/synthetic-study-session.json";
import {
  agentSourceToUiSource,
  deriveVivaAgentUiState,
  studySetToAgentSessionConfig,
} from "./use-viva-agent-session";
import { initialVivaAgentSessionState, vivaAgentReducer } from "./viva-agent-client";

describe("useVivaAgentSession adapter", () => {
  test("maps study set to agent session config without browser source tuples", () => {
    const studySet: StudySet = {
      ...seedStudySets[0],
      concepts: [
        {
          ...seedStudySets[0].concepts[0],
          source: {
            confidence: "high",
            documentId: "lec-5",
            excerpt: "Short trusted excerpt.",
            label: "Lecture 5",
            retrievalReason: "server fixture source",
            sourceId: "src-lecture-5-slide-18",
            span: "slide:18",
          },
        },
      ],
    };

    const session = studySetToAgentSessionConfig(studySet, { mode: "quiz", userId: "user-1" });

    expect(session.session_id).toBe("voice-session-1");
    expect(session.user_id).toBe("user-1");
    expect(session.study_set_id).toBe(studySet.id);
    expect(session.active_concepts).toEqual([studySet.concepts[0].id]);
    expect(session.source_context).toEqual([]);
  });

  test("allows explicit trusted session override for non-default local fixtures", () => {
    const session = studySetToAgentSessionConfig(seedStudySets[0], {
      mode: "mock",
      sessionId: "voice-session-local-fixture",
      userId: "user-local",
    });

    expect(session.session_id).toBe("voice-session-local-fixture");
    expect(session.user_id).toBe("user-local");
    expect(session.mode).toBe("mock");
  });

  test("uses server-generated study set ids before local fixture overrides", () => {
    const studySet: StudySet = {
      ...seedStudySets[0],
      id: "server-study-set-1",
      userId: "server-user-1",
      sessionId: "server-session-1",
      sessionToken: "signed-session-token",
      serverOwned: true,
      ingestionStatus: "ready",
    };

    const session = studySetToAgentSessionConfig(studySet, {
      mode: "quiz",
      sessionId: "local-session-override",
      userId: "local-user-override",
    });

    expect(session.session_id).toBe("server-session-1");
    expect(session.user_id).toBe("server-user-1");
    expect(session.study_set_id).toBe("server-study-set-1");
    expect(session.source_context).toEqual([]);
    expect("session_token" in session).toBe(false);
  });

  test("preserves full source tuple when mapping agent source to UI source", () => {
    const source: AgentStudySourceReference = {
      confidence: "high",
      document_id: "lec-5",
      excerpt: "NADH source.",
      retrieval_reason: "server fixture source for oxidative phosphorylation",
      source_id: "src-lecture-5-slide-18",
      span: "slide:18",
    };

    expect(agentSourceToUiSource(source)).toEqual({
      confidence: "high",
      documentId: "lec-5",
      excerpt: "NADH source.",
      label: "Lecture 5 · Slide 18",
      retrievalReason: "server fixture source for oxidative phosphorylation",
      sourceId: "src-lecture-5-slide-18",
      span: "slide:18",
    });
  });

  test("derives UI state from shared synthetic session frames", () => {
    let state = initialVivaAgentSessionState();
    for (const frame of fullSessionFixture.server.map(parseVivaServerFrame)) {
      state = vivaAgentReducer(state, frame);
    }

    const derived = deriveVivaAgentUiState(state);

    expect(derived.phase).toBe("recap");
    expect(derived.question?.prompt).toBe("Explain the role of NADH in oxidative phosphorylation.");
    expect(derived.evaluation?.source.sourceId).toBe("src-lecture-5-slide-18");
    expect(derived.currentSource?.sourceId).toBe("src-lecture-5-slide-18");
    expect(derived.currentConceptStatus).toBe("shaky");
    expect(derived.recap?.sourceMoments[0]?.source.documentId).toBe("lec-5");
    expect(derived.canSubmitAnswer).toBe(true);
  });

  test("derives validated manuscript intents for the scene reducer", () => {
    const derived = deriveVivaAgentUiState({
      ...initialVivaAgentSessionState(),
      manuscriptIntents: [
        {
          responseId: "response-1",
          intent: { type: "scene_intent", register: "examining", emphasis: "measured" },
        },
      ],
    });

    expect(derived.manuscriptIntents).toEqual([
      { type: "scene_intent", register: "examining", emphasis: "measured" },
    ]);
  });

  test("keeps generation metadata visible while pending submits disable duplicate answers", () => {
    const derived = deriveVivaAgentUiState({
      ...initialVivaAgentSessionState(),
      generation: {
        id: "session_bootstrap-1",
        reason: "session_bootstrap",
        sequence: 1,
      },
      pendingSubmission: {
        generationId: "session_bootstrap-1",
        kind: "text",
      },
      status: "open",
    });

    expect(derived.generationId).toBe("session_bootstrap-1");
    expect(derived.canSubmitAnswer).toBe(false);
  });
});
