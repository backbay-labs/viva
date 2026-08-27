import { describe, expect, test } from "bun:test";
import {
  agentStudySetReadiness,
  createStudySetPreview,
  generatedHomeCards,
  type PasteIngestionResponse,
  studySetFromPasteIngestionResponse,
} from "./index";
import { seedStudySets } from "./fixtures";
import { buildSessionRecap, evaluateAnswer } from "./testing/fake-evaluator";

describe("Viva study set generation", () => {
  test("creates an honest pending study set preview from pasted notes and uploaded files", () => {
    const studySet = createStudySetPreview({
      courseName: "Biology Midterm",
      examDate: "2026-06-19",
      pastedText: "Lecture notes on cellular respiration and ATP yield.",
      fileNames: ["Lecture 5.pdf"],
    });

    expect(studySet.title).toBe("Biology Midterm");
    expect(studySet.docs).toHaveLength(2);
    expect(studySet.docs.every((document) => !document.processed)).toBe(true);
    expect(studySet.docs.every((document) => document.pages === undefined)).toBe(true);
    expect(studySet.concepts).toEqual([]);
    expect(studySet.mastery).toEqual({ strong: 0, shaky: 0, review: 0 });
    expect(studySet.recommendedSession).toContain("recall drill");
  });

  test("does not invent uploaded files for paste-only previews", () => {
    const studySet = createStudySetPreview({
      courseName: "Chemistry Final",
      pastedText: "SN1 and SN2 notes.",
      fileNames: [],
    });

    expect(studySet.docs.map((document) => document.name)).toEqual(["Pasted notes"]);
    expect(studySet.docs[0]?.processed).toBe(false);
    expect(studySet.docs[0]?.pages).toBeUndefined();
  });

  test("caps generated home cards to four", () => {
    expect(generatedHomeCards(seedStudySets[0])).toHaveLength(4);
  });

  test("gates connected agent sessions to trusted processed study sets", () => {
    expect(agentStudySetReadiness(seedStudySets[0])).toEqual({
      canConnect: true,
      reason: "trusted",
      message: "Connected agent is mapped to a trusted server study set.",
    });

    const pendingPreview = createStudySetPreview({
      courseName: "Biology Midterm",
      pastedText: "Lecture notes on cellular respiration.",
    });

    expect(agentStudySetReadiness(pendingPreview)).toEqual({
      canConnect: false,
      reason: "pending_ingestion",
      message:
        "Connected agent is unavailable until source-grounded ingestion returns concepts and processed documents.",
    });

    expect(agentStudySetReadiness({ ...seedStudySets[0], id: "local-unmapped-study-set" })).toEqual(
      {
        canConnect: false,
        reason: "unmapped_fixture",
        message:
          "Connected agent is unavailable for this local preview because no trusted server fixture is mapped.",
      },
    );
  });

  test("allows server-owned ready study sets and blocks non-ready ingestion states", () => {
    const readyStudySet = studySetFromPasteIngestionResponse(serverPasteResponse("ready"));

    expect(agentStudySetReadiness(readyStudySet)).toEqual({
      canConnect: true,
      reason: "trusted",
      message: "Connected agent is mapped to a trusted server study set.",
    });
    expect(readyStudySet.id).toBe("server-study-set-1");
    expect(readyStudySet.userId).toBe("server-user-1");
    expect(readyStudySet.sessionId).toBe("server-session-1");
    expect(readyStudySet.sessionToken).toBe("signed-session-token");
    expect(readyStudySet.docs[0]?.processed).toBe(true);
    expect(readyStudySet.concepts[0]?.source.sourceId).toBe("span-1");

    expect(
      agentStudySetReadiness(studySetFromPasteIngestionResponse(serverPasteResponse("processing"))),
    ).toMatchObject({
      canConnect: false,
      reason: "processing_ingestion",
    });
    const failedStudySet = studySetFromPasteIngestionResponse(serverPasteResponse("failed"));
    expect(agentStudySetReadiness(failedStudySet)).toMatchObject({
      canConnect: false,
      reason: "failed_ingestion",
    });
    expect(failedStudySet.sessionToken).toBe(null);
    expect(failedStudySet.concepts).toEqual([]);
    expect(
      failedStudySet.generatedCards.some((card) => card.id === "server-ingestion-failed"),
    ).toBe(true);

    const retryStudySet = studySetFromPasteIngestionResponse(serverPasteResponse("retry"));
    expect(agentStudySetReadiness(retryStudySet)).toMatchObject({
      canConnect: false,
      reason: "retry_ingestion",
    });
    expect(retryStudySet.lastSessionLabel).toBe("Server ingestion awaiting retry");
    expect(retryStudySet.generatedCards.some((card) => card.id === "server-ingestion-retry")).toBe(
      true,
    );
  });
});

describe("Viva answer evaluation", () => {
  test("flags course-specific ATP discrepancies", () => {
    const evaluation = evaluateAnswer("I think aerobic respiration produces 36 ATP.");

    expect(evaluation.correctionKind).toBe("course-specific discrepancy");
    expect(evaluation.conceptStatus).toBe("shaky");
    expect(evaluation.source.label).toBe("Lecture 5 · slide 12");
  });

  test("recognizes mechanism-heavy answers", () => {
    const evaluation = evaluateAnswer(
      "NADH is an electron donor to the electron transport chain, which builds a proton gradient for ATP synthase.",
    );

    expect(evaluation.label).toBe("mostly correct");
    expect(evaluation.conceptStatus).toBe("strong");
  });

  test("builds recap review labels from the canonical Biology concept vocabulary", () => {
    const evaluation = evaluateAnswer(
      "NADH is an electron donor to the electron transport chain, which builds a proton gradient for ATP synthase.",
    );
    const recap = buildSessionRecap(evaluation);

    expect(seedStudySets[0].concepts.map((concept) => concept.label)).toContain("ATP synthase");
    expect(recap.reviewLater).toContain("ATP synthase");
    expect(recap.reviewLater).not.toContain("ATP yield");
    expect(recap.plan[1]?.topics).toContain("ATP synthase");
    expect(recap.plan[1]?.topics).not.toContain("ATP yield");
  });
});

function serverPasteResponse(
  status: "pending" | "processing" | "ready" | "failed" | "retry",
): PasteIngestionResponse {
  const ready = status === "ready";
  return {
    study_set: {
      id: "server-study-set-1",
      user_id: "server-user-1",
      title: "Server Biology",
      course: "Biology 201",
      ingestion_status: status,
    },
    documents: [
      {
        id: "doc-1",
        display_name: "Pasted notes",
        source_kind: "pasted_text",
        processing_status: status,
      },
    ],
    source_spans: ready
      ? [
          {
            id: "span-1",
            document_id: "doc-1",
            locator: { span: "chars:0-42" },
            excerpt: "NADH donates electrons to the transport chain.",
            confidence: "high",
            retrieval_reason: "paste ingestion",
          },
        ]
      : [],
    concepts: ready
      ? [
          {
            public_id: "oxidative-phosphorylation",
            label: "Oxidative phosphorylation",
            status: "shaky",
            source_span_id: "span-1",
          },
        ]
      : [],
    questions: ready
      ? [
          {
            question_id: "question-1",
            prompt: "Explain NADH.",
            expected_terms: ["electron donor"],
            follow_up: "Connect it to ATP synthase.",
            source: {
              source_id: "span-1",
              document_id: "doc-1",
              span: "chars:0-42",
              excerpt: "NADH donates electrons to the transport chain.",
              confidence: "high",
              retrieval_reason: "paste ingestion",
            },
          },
        ]
      : [],
    session_token: ready ? "signed-session-token" : null,
    session_id: "server-session-1",
  };
}
