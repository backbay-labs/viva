export * from "./agent-contract";
export * from "./learner-loop-contract";
export * from "./learner-recovery-copy";
export * from "./scheduling";

export type StudyMode = "quiz" | "teach" | "mock" | "cram";
export type ConceptStatus = "strong" | "shaky" | "missed" | "review";
export type SessionPhase = "ready" | "listening" | "thinking" | "feedback" | "correction" | "recap";
export type CorrectionKind =
  | "wrong"
  | "partially correct"
  | "correct but incomplete"
  | "correct but imprecise"
  | "course-specific discrepancy";
export type EvaluationLabel =
  | "strong"
  | "mostly correct"
  | "partially correct"
  | "vague"
  | "wrong"
  | "off-topic"
  | "insufficient evidence";

export type UploadedDocument = {
  id: string;
  name: string;
  kind: "pdf" | "slides" | "notes" | "transcript" | "pasted text";
  pages?: number;
  progress: number;
  processed: boolean;
};

export type StudySetIngestionStatus = "pending" | "processing" | "ready" | "failed" | "retry";

export type SourceReference = {
  label: string;
  excerpt: string;
  confidence: "high" | "medium" | "low";
  sourceId?: string;
  documentId?: string;
  span?: string;
  retrievalReason?: string;
};

export type Concept = {
  id: string;
  label: string;
  status: ConceptStatus;
  misses: number;
  source: SourceReference;
  centrality: number;
};

export type GeneratedCard = {
  id: string;
  kind: "weak concept" | "next best session" | "exam focus" | "review tomorrow";
  title: string;
  body: string;
  accent: "plum" | "sage" | "gold" | "amber";
};

export type StudySet = {
  id: string;
  userId?: string;
  title: string;
  course: string | null;
  docs: UploadedDocument[];
  ingestionStatus?: StudySetIngestionStatus;
  serverOwned?: boolean;
  sessionId?: string;
  sessionToken?: string | null;
  examDateLabel: string;
  lastSessionLabel: string;
  concepts: Concept[];
  mastery: {
    strong: number;
    shaky: number;
    review: number;
  };
  recommendedSession: string;
  generatedCards: GeneratedCard[];
};

export type AgentStudySetReadiness =
  | {
      canConnect: true;
      reason: "trusted";
      message: string;
    }
  | {
      canConnect: false;
      reason:
        | "pending_ingestion"
        | "processing_ingestion"
        | "failed_ingestion"
        | "retry_ingestion"
        | "unmapped_fixture";
      message: string;
    };

export const DEFAULT_TRUSTED_AGENT_STUDY_SET_ID = "biology-midterm";

export type SessionQuestion = {
  id: string;
  prompt: string;
  source: SourceReference;
  expectedTerms: string[];
  followUp: string;
};

export type PasteIngestionStudySet = {
  id: string;
  user_id: string;
  title: string;
  course: string | null;
  ingestion_status: StudySetIngestionStatus;
};

export type PasteIngestionDocument = {
  id: string;
  display_name: string;
  source_kind: string;
  processing_status: string;
};

export type PasteIngestionSourceSpan = {
  id: string;
  document_id: string;
  locator: { span: string };
  excerpt: string;
  confidence: SourceReference["confidence"];
  retrieval_reason: string;
};

export type PasteIngestionConcept = {
  public_id: string;
  label: string;
  status: ConceptStatus;
  source_span_id: string;
};

export type PasteIngestionQuestion = {
  question_id: string;
  prompt: string;
  expected_terms: string[];
  follow_up: string;
  source: {
    source_id: string;
    document_id: string;
    span: string;
    excerpt: string;
    confidence: SourceReference["confidence"];
    retrieval_reason: string;
  };
};

export type PasteIngestionResponse = {
  study_set: PasteIngestionStudySet;
  documents: PasteIngestionDocument[];
  source_spans: PasteIngestionSourceSpan[];
  concepts: PasteIngestionConcept[];
  questions: PasteIngestionQuestion[];
  session_token: string | null;
  session_id: string;
};

export type AnswerEvaluation = {
  label: EvaluationLabel;
  correctionKind: CorrectionKind;
  conciseFeedback: string;
  retryPrompt: string;
  source: SourceReference;
  conceptStatus: ConceptStatus;
  confidenceScore: number;
};

export type SessionRecap = {
  headline: string;
  durationLabel: string;
  summary: string;
  strongConcepts: string[];
  shakyConcepts: string[];
  missedConcepts: string[];
  reviewLater: string[];
  nextAction: string;
  sourceMoments: Array<{ text: string; source: SourceReference; status: ConceptStatus }>;
  plan: Array<{ day: string; topics: string; meta: string; status: "done" | "today" | "upcoming" }>;
};

export const sampleQuestion: SessionQuestion = {
  id: "nad-h-oxidative-phosphorylation",
  prompt: "Explain the role of NADH in oxidative phosphorylation.",
  expectedTerms: ["electron donor", "electron transport chain", "proton gradient", "ATP synthase"],
  followUp: "Now connect that electron flow to ATP synthase in one precise sentence.",
  source: {
    label: "Lecture 5 · slide 18",
    confidence: "high",
    excerpt:
      "NADH donates high-energy electrons to the electron transport chain. Electron flow pumps protons across the inner mitochondrial membrane, creating the gradient that drives ATP synthase.",
  },
};

export const sourceConflictExample: SourceReference = {
  label: "Lecture 5 · slide 12",
  confidence: "medium",
  excerpt:
    "For this course, use approximately 30-32 ATP per glucose because ATP yield varies by shuttle system. The textbook excerpt also mentions the older 36-38 ATP accounting.",
};

export const seedStudySets: StudySet[] = [
  {
    id: "biology-midterm",
    title: "Biology Midterm",
    course: "Biology 201",
    examDateLabel: "Exam Friday",
    lastSessionLabel: "Studied 45 minutes ago",
    docs: [
      {
        id: "lec-4",
        name: "Lecture 4 - Glycolysis.pdf",
        kind: "pdf",
        pages: 24,
        progress: 100,
        processed: true,
      },
      {
        id: "lec-5",
        name: "Lecture 5 - Electron Transport.pdf",
        kind: "pdf",
        pages: 31,
        progress: 100,
        processed: true,
      },
      {
        id: "midterm-review",
        name: "Midterm review notes",
        kind: "notes",
        pages: 9,
        progress: 100,
        processed: true,
      },
    ],
    concepts: [
      concept(
        "cellular-respiration",
        "Cellular respiration",
        "shaky",
        2,
        sourceConflictExample,
        95,
      ),
      concept("glycolysis", "Glycolysis", "strong", 0, sampleQuestion.source, 82),
      concept("krebs-cycle", "Krebs cycle", "review", 1, sampleQuestion.source, 74),
      concept(
        "oxidative-phosphorylation",
        "Oxidative phosphorylation",
        "shaky",
        2,
        sampleQuestion.source,
        96,
      ),
      concept("photosynthesis", "Photosynthesis", "strong", 0, sampleQuestion.source, 58),
      concept("nadh", "NADH", "review", 1, sampleQuestion.source, 91),
      concept("atp-synthase", "ATP synthase", "missed", 3, sampleQuestion.source, 88),
    ],
    mastery: {
      strong: 72,
      shaky: 18,
      review: 10,
    },
    recommendedSession: "10-minute recall drill on Lectures 4-5",
    generatedCards: [
      {
        id: "weak-cellular-respiration",
        kind: "weak concept",
        title: "Cellular respiration",
        body: "You missed this twice. Start here before adding new material.",
        accent: "amber",
      },
      {
        id: "next-lecture-5",
        kind: "next best session",
        title: "Lecture 5 recall",
        body: "Electron transport, shuttle systems, and ATP synthase · 10 min",
        accent: "plum",
      },
      {
        id: "exam-friday",
        kind: "exam focus",
        title: "Exam Friday",
        body: "Prioritize Lectures 4-6 and professor-specific ATP accounting.",
        accent: "gold",
      },
      {
        id: "review-tomorrow",
        kind: "review tomorrow",
        title: "NADH, Krebs cycle",
        body: "Bring these back tomorrow before the cram session.",
        accent: "sage",
      },
    ],
  },
  {
    id: "organic-chemistry",
    title: "Organic Chemistry",
    course: "Chemistry 221",
    examDateLabel: "Exam in 2 weeks",
    lastSessionLabel: "Studied yesterday",
    docs: [
      doc("orgo-7", "Chapter 7 reaction mechanisms.pdf", "pdf", 18),
      doc("orgo-lab", "Lab mechanism notes", "notes", 6),
      doc("orgo-quiz", "Professor quiz transcript", "transcript", 4),
      doc("orgo-map", "Reaction map slides.pdf", "slides", 22),
      doc("orgo-review", "Study guide", "notes", 12),
    ],
    concepts: [
      concept("sn1", "SN1 mechanism", "strong", 0, sampleQuestion.source, 62),
      concept("sn2", "SN2 mechanism", "shaky", 1, sampleQuestion.source, 73),
      concept("leaving-groups", "Leaving groups", "review", 1, sampleQuestion.source, 68),
    ],
    mastery: {
      strong: 54,
      shaky: 28,
      review: 18,
    },
    recommendedSession: "12-minute reaction mechanism drill",
    generatedCards: [],
  },
  {
    id: "psychology-101",
    title: "Psychology 101",
    course: "Psych 101",
    examDateLabel: "No exam set",
    lastSessionLabel: "Studied 4 days ago",
    docs: [
      doc("psych-memory", "Memory models notes", "notes", 8),
      doc("psych-ch5", "Chapter 5.pdf", "pdf", 27),
    ],
    concepts: [
      concept("working-memory", "Working memory", "strong", 0, sampleQuestion.source, 69),
      concept("conditioning", "Operant conditioning", "review", 1, sampleQuestion.source, 76),
    ],
    mastery: {
      strong: 81,
      shaky: 11,
      review: 8,
    },
    recommendedSession: "8-minute memory models quiz",
    generatedCards: [],
  },
];

export function createStudySetPreview(input: {
  courseName?: string;
  examDate?: string;
  pastedText?: string;
  fileNames?: string[];
}): StudySet {
  const fileNames = input.fileNames ?? [];
  const pastedText = input.pastedText?.trim() ?? "";
  const title = normalizeTitle(input.courseName) || inferTitle(fileNames, pastedText);
  const examDateLabel = input.examDate
    ? formatExamLabel(input.examDate)
    : inferExamDate(pastedText);
  const docs = fileNames.map((name, index) => ({
    id: `uploaded-${index + 1}`,
    name,
    kind: inferKind(name),
    progress: 0,
    processed: false,
  }));

  if (pastedText) {
    docs.push({
      id: "pasted-notes",
      name: "Pasted notes",
      kind: "pasted text",
      progress: 0,
      processed: false,
    });
  }

  return {
    id: slugify(title),
    title,
    course: title,
    docs,
    ingestionStatus: "pending",
    serverOwned: false,
    examDateLabel,
    lastSessionLabel: "No agent sessions yet",
    concepts: [],
    mastery: {
      strong: 0,
      shaky: 0,
      review: 0,
    },
    recommendedSession: "10-minute recall drill after ingestion is connected",
    generatedCards: generatePreviewCards(examDateLabel),
  };
}

export function studySetFromPasteIngestionResponse(
  response: PasteIngestionResponse,
  options: { examDate?: string } = {},
): StudySet {
  const sourceSpansById = new Map(response.source_spans.map((span) => [span.id, span]));
  const concepts = response.concepts.map((serverConcept, index) => {
    const sourceSpan = sourceSpansById.get(serverConcept.source_span_id);
    return concept(
      serverConcept.public_id,
      serverConcept.label,
      serverConcept.status,
      serverConcept.status === "missed" ? 1 : 0,
      sourceSpan
        ? serverSourceSpanToSourceReference(sourceSpan)
        : {
            confidence: "low",
            excerpt: "",
            label: "Server source unavailable",
            retrievalReason: "server did not return the referenced source span",
            sourceId: serverConcept.source_span_id,
          },
      Math.max(20, 100 - index * 8),
    );
  });
  const mastery = masteryFromConcepts(concepts);
  const examDateLabel = options.examDate ? formatExamLabel(options.examDate) : "Exam date optional";
  const firstQuestion = response.questions[0]?.prompt;

  return {
    id: response.study_set.id,
    userId: response.study_set.user_id,
    title: response.study_set.title,
    course: response.study_set.course,
    docs: response.documents.map((document) =>
      serverDocumentToUploadedDocument(document, response.study_set.ingestion_status),
    ),
    ingestionStatus: response.study_set.ingestion_status,
    serverOwned: true,
    sessionId: response.session_id,
    sessionToken: response.session_token,
    examDateLabel,
    lastSessionLabel: serverIngestionSessionLabel(response.study_set.ingestion_status),
    concepts,
    mastery,
    recommendedSession: firstQuestion
      ? `Start with: ${firstQuestion}`
      : response.study_set.ingestion_status === "ready"
        ? "10-minute source-grounded recall drill"
        : "10-minute recall drill after ingestion is ready",
    generatedCards: generateServerCards(
      response.study_set.ingestion_status,
      concepts,
      examDateLabel,
    ),
  };
}

export function evaluateAnswer(answer: string): AnswerEvaluation {
  const normalized = answer.toLowerCase();
  const termsPresent = sampleQuestion.expectedTerms.filter((term) => normalized.includes(term));
  const mentionsAtpOnly = normalized.includes("atp") && termsPresent.length < 2;
  const mentionsOldYield = /\b36\b|\b38\b/.test(normalized);

  if (mentionsOldYield) {
    return {
      label: "partially correct",
      correctionKind: "course-specific discrepancy",
      conciseFeedback:
        "Close, but for this course use 30-32 ATP. The older textbook accounting is not the number your professor emphasized.",
      retryPrompt: "Try again using the phrase 'shuttle system'.",
      source: sourceConflictExample,
      conceptStatus: "shaky",
      confidenceScore: 0.58,
    };
  }

  if (termsPresent.length >= 3) {
    return {
      label: "mostly correct",
      correctionKind: "correct but incomplete",
      conciseFeedback:
        "Good mechanism. Add one sentence that explicitly connects the proton gradient to ATP synthase.",
      retryPrompt: sampleQuestion.followUp,
      source: sampleQuestion.source,
      conceptStatus: "strong",
      confidenceScore: 0.84,
    };
  }

  if (mentionsAtpOnly || termsPresent.length > 0) {
    return {
      label: "partially correct",
      correctionKind: "correct but imprecise",
      conciseFeedback:
        "Good start. You named ATP, but the mechanism is missing: NADH donates electrons to the electron transport chain, helping build the proton gradient that drives ATP synthase.",
      retryPrompt: "Try again using 'electron donor' and 'proton gradient'.",
      source: sampleQuestion.source,
      conceptStatus: "shaky",
      confidenceScore: 0.52,
    };
  }

  return {
    label: answer.trim() ? "vague" : "insufficient evidence",
    correctionKind: answer.trim() ? "partially correct" : "wrong",
    conciseFeedback:
      "That is too vague for an exam answer. Start with NADH as an electron donor, then explain the gradient.",
    retryPrompt: "Try again in two sentences, with one mechanism and one consequence.",
    source: sampleQuestion.source,
    conceptStatus: "missed",
    confidenceScore: answer.trim() ? 0.3 : 0.08,
  };
}

export function buildSessionRecap(evaluation: AnswerEvaluation): SessionRecap {
  const shakyConcept = evaluation.conceptStatus === "strong" ? "ATP synthase" : "NADH";
  return {
    headline: "Good session, Ananya.",
    durationLabel: "10 min",
    summary:
      evaluation.conceptStatus === "strong"
        ? "You explained the core mechanism. The next pass should tighten exam wording."
        : "You are close, but oxidative phosphorylation needs another pass before Friday.",
    strongConcepts: ["Photosynthesis basics", "Glycolysis"],
    shakyConcepts: [shakyConcept, "Krebs cycle"],
    missedConcepts: evaluation.conceptStatus === "missed" ? ["Electron transport chain"] : [],
    reviewLater: ["ATP synthase", "Shuttle systems"],
    nextAction: "Schedule tomorrow's recall drill",
    sourceMoments: [
      {
        text: evaluation.conciseFeedback,
        source: evaluation.source,
        status: evaluation.conceptStatus,
      },
      {
        text: "Skipped the mechanism of the proton gradient.",
        source: sampleQuestion.source,
        status: "shaky",
      },
    ],
    plan: [
      {
        day: "Today",
        topics: "Cellular respiration · Photosynthesis · Enzymes",
        meta: "Completed",
        status: "done",
      },
      {
        day: "Tomorrow · 15 min",
        topics: "NADH · Krebs cycle · ATP synthase",
        meta: "Scheduled",
        status: "today",
      },
      {
        day: "Fri 16 May · 15 min",
        topics: "Cell cycle · Mitosis",
        meta: "Pre-exam",
        status: "upcoming",
      },
    ],
  };
}

export function generatedHomeCards(studySet: StudySet): GeneratedCard[] {
  return studySet.generatedCards.slice(0, 4);
}

export function agentStudySetReadiness(
  studySet: StudySet,
  trustedStudySetId = DEFAULT_TRUSTED_AGENT_STUDY_SET_ID,
): AgentStudySetReadiness {
  if (studySet.serverOwned) {
    if (studySet.ingestionStatus === "failed") {
      return {
        canConnect: false,
        reason: "failed_ingestion",
        message: "Connected agent is unavailable because server ingestion failed.",
      };
    }
    if (studySet.ingestionStatus === "retry") {
      return {
        canConnect: false,
        reason: "retry_ingestion",
        message: "Connected agent is unavailable until file ingestion is retried.",
      };
    }
    if (studySet.ingestionStatus === "processing") {
      return {
        canConnect: false,
        reason: "processing_ingestion",
        message:
          "Connected agent is unavailable while the server is still processing this study set.",
      };
    }
    if (studySet.ingestionStatus === "pending") {
      return {
        canConnect: false,
        reason: "pending_ingestion",
        message: "Connected agent is unavailable until server ingestion starts processing sources.",
      };
    }
    if (studySet.ingestionStatus === "ready" && hasProcessedDocumentsAndConcepts(studySet)) {
      return {
        canConnect: true,
        reason: "trusted",
        message: "Connected agent is mapped to a trusted server study set.",
      };
    }
    return {
      canConnect: false,
      reason: "pending_ingestion",
      message:
        "Connected agent is unavailable until source-grounded ingestion returns concepts and processed documents.",
    };
  }

  if (!hasProcessedDocumentsAndConcepts(studySet)) {
    return {
      canConnect: false,
      reason:
        studySet.ingestionStatus === "processing"
          ? "processing_ingestion"
          : studySet.ingestionStatus === "failed"
            ? "failed_ingestion"
            : studySet.ingestionStatus === "retry"
              ? "retry_ingestion"
              : "pending_ingestion",
      message:
        studySet.ingestionStatus === "failed"
          ? "Connected agent is unavailable because server ingestion failed."
          : studySet.ingestionStatus === "retry"
            ? "Connected agent is unavailable until file ingestion is retried."
            : "Connected agent is unavailable until source-grounded ingestion returns concepts and processed documents.",
    };
  }

  if (studySet.id !== trustedStudySetId) {
    return {
      canConnect: false,
      reason: "unmapped_fixture",
      message:
        "Connected agent is unavailable for this local preview because no trusted server fixture is mapped.",
    };
  }
  return {
    canConnect: true,
    reason: "trusted",
    message: "Connected agent is mapped to a trusted server study set.",
  };
}

function hasProcessedDocumentsAndConcepts(studySet: StudySet): boolean {
  return (
    studySet.docs.length > 0 &&
    studySet.concepts.length > 0 &&
    studySet.docs.every((document) => document.processed)
  );
}

function serverDocumentToUploadedDocument(
  document: PasteIngestionDocument,
  ingestionStatus: StudySetIngestionStatus,
): UploadedDocument {
  const processed =
    ingestionStatus === "ready" ||
    document.processing_status === "ready" ||
    document.processing_status === "processed" ||
    document.processing_status === "complete" ||
    document.processing_status === "completed";
  return {
    id: document.id,
    name: document.display_name,
    kind: sourceKindToUploadedDocumentKind(document.source_kind),
    progress: processed ? 100 : ingestionStatus === "failed" ? 100 : 50,
    processed,
  };
}

function sourceKindToUploadedDocumentKind(sourceKind: string): UploadedDocument["kind"] {
  const normalized = sourceKind.toLowerCase().replace(/[_\s-]+/g, " ");
  if (normalized.includes("pdf")) return "pdf";
  if (normalized.includes("slide")) return "slides";
  if (normalized.includes("transcript")) return "transcript";
  if (normalized.includes("paste")) return "pasted text";
  return "notes";
}

function serverSourceSpanToSourceReference(sourceSpan: PasteIngestionSourceSpan): SourceReference {
  return {
    confidence: sourceSpan.confidence,
    documentId: sourceSpan.document_id,
    excerpt: sourceSpan.excerpt,
    label: `${sourceSpan.document_id} · ${sourceSpan.locator.span}`,
    retrievalReason: sourceSpan.retrieval_reason,
    sourceId: sourceSpan.id,
    span: sourceSpan.locator.span,
  };
}

function masteryFromConcepts(concepts: Concept[]): StudySet["mastery"] {
  if (concepts.length === 0) {
    return { strong: 0, shaky: 0, review: 0 };
  }
  const strong = concepts.filter((item) => item.status === "strong").length;
  const shaky = concepts.filter((item) => item.status === "shaky").length;
  const review = concepts.filter(
    (item) => item.status === "review" || item.status === "missed",
  ).length;
  return {
    strong: Math.round((strong / concepts.length) * 100),
    shaky: Math.round((shaky / concepts.length) * 100),
    review: Math.round((review / concepts.length) * 100),
  };
}

function serverIngestionSessionLabel(status: StudySetIngestionStatus): string {
  if (status === "ready") return "Server ingestion ready";
  if (status === "failed") return "Server ingestion failed";
  if (status === "retry") return "Server ingestion awaiting retry";
  if (status === "processing") return "Server ingestion processing";
  return "Server ingestion pending";
}

function generateServerCards(
  status: StudySetIngestionStatus,
  concepts: Concept[],
  examDateLabel: string,
): GeneratedCard[] {
  if (status !== "ready") {
    return [
      {
        id: `server-ingestion-${status}`,
        kind: status === "failed" ? "weak concept" : "next best session",
        title:
          status === "failed"
            ? "Server ingestion failed"
            : status === "retry"
              ? "Server ingestion awaiting retry"
              : status === "processing"
                ? "Server ingestion processing"
                : "Server ingestion pending",
        body:
          status === "failed"
            ? "The connected agent is blocked until ingestion succeeds."
            : status === "retry"
              ? "Upload a fresh file or retry processing before starting the connected agent."
              : "The connected agent will unlock after processed documents and concepts return.",
        accent: status === "failed" ? "amber" : "plum",
      },
      {
        id: "server-ingestion-exam-date",
        kind: "exam focus",
        title: examDateLabel,
        body: "Exam timing is captured while server ingestion completes.",
        accent: "gold",
      },
    ];
  }
  const firstConcept = concepts.find((item) => item.status !== "strong") ?? concepts[0];
  return [
    {
      id: "server-ready-session",
      kind: "next best session",
      title: "Source-grounded recall",
      body: "The server returned processed documents, concepts, and a signed session handoff.",
      accent: "plum",
    },
    {
      id: "server-ready-focus",
      kind: "weak concept",
      title: firstConcept?.label ?? "First concept",
      body: "Start with the highest-priority concept from server ingestion.",
      accent: firstConcept?.status === "missed" ? "amber" : "sage",
    },
    {
      id: "server-ready-exam-date",
      kind: "exam focus",
      title: examDateLabel,
      body: "Use this timing to pace the connected viva drills.",
      accent: "gold",
    },
  ];
}

function doc(
  id: string,
  name: string,
  kind: UploadedDocument["kind"],
  pages: number,
): UploadedDocument {
  return { id, name, kind, pages, progress: 100, processed: true };
}

function concept(
  id: string,
  label: string,
  status: ConceptStatus,
  misses: number,
  source: SourceReference,
  centrality: number,
): Concept {
  return { id, label, status, misses, source, centrality };
}

function generatePreviewCards(examDateLabel: string): GeneratedCard[] {
  return [
    {
      id: "preview-upload-captured",
      kind: "next best session",
      title: "Study set shell ready",
      body: "Documents are queued for the local preview. Source-grounded extraction is not trusted yet.",
      accent: "plum",
    },
    {
      id: "preview-first-drill",
      kind: "review tomorrow",
      title: "First recall drill",
      body: "Use the connected agent only after the server returns the prompt and sources.",
      accent: "sage",
    },
    {
      id: "preview-exam-date",
      kind: "exam focus",
      title: examDateLabel,
      body: "Exam timing is captured; concept ranking waits for real ingestion.",
      accent: "gold",
    },
  ];
}

function inferKind(name: string): UploadedDocument["kind"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.includes("slide") || lower.endsWith(".ppt") || lower.endsWith(".pptx")) return "slides";
  if (lower.includes("transcript")) return "transcript";
  return "notes";
}

function inferTitle(fileNames: string[], pastedText: string): string {
  const joined = `${fileNames.join(" ")} ${pastedText}`.toLowerCase();
  if (joined.includes("bio") || joined.includes("cell") || joined.includes("respiration")) {
    return "Biology Midterm";
  }
  if (joined.includes("chem")) return "Chemistry Study Set";
  if (joined.includes("psych")) return "Psychology Review";
  return "New Study Set";
}

function inferExamDate(text: string): string {
  if (/friday|fri/i.test(text)) return "Exam Friday";
  if (/tomorrow/i.test(text)) return "Exam tomorrow";
  return "Exam date optional";
}

function formatExamLabel(value: string): string {
  if (!value) return "Exam date optional";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "Exam date set";
  return `Exam ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function normalizeTitle(value?: string): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
