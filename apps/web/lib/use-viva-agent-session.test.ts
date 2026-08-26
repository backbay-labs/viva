import { describe, expect, test } from "bun:test";
import {
  type AgentStudySourceReference,
  parseVivaServerFrame,
  type StudySet,
  seedStudySets,
} from "@viva/core";
import fullSessionFixture from "../../../agent/fixtures/voice-protocol/v5/synthetic-runtime-session.json";
import {
  agentSourceToUiSource,
  createVivaAgentAudioCommands,
  deriveVivaAgentUiState,
  studySetToAgentSessionConfig,
} from "./use-viva-agent-session";
import {
  initialVivaAgentSessionState,
  type VivaAgentSessionController,
  type VivaAudioSendResult,
  vivaAgentReducer,
} from "./viva-agent-client";

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

/**
 * The hook's audio surface is the pure command factory the hook itself uses, so
 * the four v5 audio methods are provable without a DOM: `bun:test` has no DOM
 * environment at this base and this lane does not add one.
 */
describe("viva agent audio commands", () => {
  const sent: VivaAudioSendResult = { acceptedThroughSequence: 4, status: "sent" };
  const pending: VivaAudioSendResult = {
    acceptedThroughSequence: 4,
    retainedFromSequence: 5,
    status: "pending",
  };

  test("delegates the four audio methods to the controller and returns results unchanged", () => {
    const calls: string[] = [];
    const controller = {
      cancelAudioTurn: (turnId: string) => {
        calls.push(`cancel:${turnId}`);
      },
      endAudioTurn: (input: { turnId: string; finalSequence: number }) => {
        calls.push(`end:${input.turnId}:${input.finalSequence}`);
        return pending;
      },
      retryPendingAudio: () => {
        calls.push("retry");
        return sent;
      },
      sendAudioChunk: (input: { turnId: string; sequence: number; pcm16Bytes: Uint8Array }) => {
        calls.push(`chunk:${input.turnId}:${input.sequence}:${input.pcm16Bytes.byteLength}`);
        return sent;
      },
    } as unknown as VivaAgentSessionController;
    const commands = createVivaAgentAudioCommands(() => controller);

    expect(
      commands.sendAudioChunk({
        pcm16Bytes: new Uint8Array(960),
        sequence: 0,
        turnId: "turn-hook",
      }),
    ).toBe(sent);
    expect(commands.endAudioTurn({ finalSequence: 0, turnId: "turn-hook" })).toBe(pending);
    commands.cancelAudioTurn("turn-hook");
    expect(commands.retryPendingAudio()).toBe(sent);

    expect(calls).toEqual([
      "chunk:turn-hook:0:960",
      "end:turn-hook:0",
      "cancel:turn-hook",
      "retry",
    ]);
  });

  test("returns a retryable socket_closed result while no controller is mounted", () => {
    const commands = createVivaAgentAudioCommands(() => null);
    const disconnected = {
      code: "socket_closed",
      message: "Viva agent session is not connected",
    } as const;

    expect(
      commands.sendAudioChunk({ pcm16Bytes: new Uint8Array(2), sequence: 7, turnId: "turn-hook" }),
    ).toEqual({
      acceptedThroughSequence: null,
      error: disconnected,
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(commands.endAudioTurn({ finalSequence: 7, turnId: "turn-hook" })).toEqual({
      acceptedThroughSequence: null,
      error: disconnected,
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(commands.retryPendingAudio()).toEqual({
      acceptedThroughSequence: null,
      error: disconnected,
      retainedFromSequence: 0,
      retryable: true,
      status: "socket_closed",
    });
    expect(() => commands.cancelAudioTurn("turn-hook")).not.toThrow();
  });
});
