export type SessionPhase =
  | "correction"
  | "listening"
  | "mic-blocked"
  | "ready"
  | "requesting"
  | "thinking";

export type SessionState = {
  phase: SessionPhase;
  recoveryMessage?: string;
};

export type SessionEvent =
  | { type: "BEGIN" }
  | { type: "MIC_GRANTED" }
  | { type: "MIC_DENIED"; message: string }
  | { type: "SUBMIT" }
  | { type: "EVALUATED" }
  | { type: "RETRY" };

export const initialSessionState: SessionState = { phase: "ready" };

export type PrototypeCorrection = {
  correction: string;
  source: string;
  sourceExcerpt: string;
  title: string;
};

export function buildPrototypeCorrection(answer: string): PrototypeCorrection {
  const normalized = answer.toLowerCase();
  const namesElectrons = normalized.includes("electron");
  const namesGradient = normalized.includes("proton") || normalized.includes("gradient");

  if (namesElectrons && namesGradient) {
    return {
      correction:
        "You named electron transfer and proton pumping. Make the causal link explicit: NADH donates high-energy electrons to Complex I, and that transfer powers the gradient used by ATP synthase.",
      source: "Lecture 5 · slide 18",
      sourceExcerpt:
        "NADH oxidation transfers electrons to Complex I, coupling electron flow to proton translocation.",
      title: "Good foundation—make the link explicit.",
    };
  }

  if (normalized.includes("36") || normalized.includes("atp")) {
    return {
      correction:
        "Do not assign NADH one fixed ATP total. Its role is to donate high-energy electrons to Complex I. For this course, the overall yield is 30–32 ATP because the shuttle changes the total.",
      source: "Lecture 5 · slide 12",
      sourceExcerpt:
        "The ATP yield varies with the shuttle used to transfer cytosolic NADH electrons.",
      title: "Almost—separate the role from the yield.",
    };
  }

  return {
    correction:
      "Start with the transfer: NADH donates high-energy electrons to Complex I. Their movement through the chain powers proton pumping, creating the gradient used by ATP synthase.",
    source: "Lecture 5 · slide 18",
    sourceExcerpt:
      "Electron transfer from NADH is coupled to proton pumping across the inner mitochondrial membrane.",
    title: "Not yet—build it from the transfer.",
  };
}

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "BEGIN":
      return state.phase === "ready" ? { phase: "requesting" } : state;
    case "MIC_GRANTED":
      return state.phase === "requesting" ? { phase: "listening" } : state;
    case "MIC_DENIED":
      return state.phase === "requesting"
        ? { phase: "mic-blocked", recoveryMessage: event.message }
        : state;
    case "SUBMIT":
      return state.phase === "listening" || state.phase === "ready" || state.phase === "mic-blocked"
        ? { phase: "thinking" }
        : state;
    case "EVALUATED":
      return state.phase === "thinking" ? { phase: "correction" } : state;
    case "RETRY":
      return state.phase === "correction" || state.phase === "mic-blocked"
        ? { phase: "ready" }
        : state;
  }
}
