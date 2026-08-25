import { describe, expect, test } from "bun:test";

import { buildPrototypeCorrection, initialSessionState, sessionReducer } from "./session-machine";

describe("buildPrototypeCorrection", () => {
  test("recognizes an answer that connects electrons and the proton gradient", () => {
    const feedback = buildPrototypeCorrection(
      "NADH donates electrons, and the chain uses that energy to pump protons.",
    );

    expect(feedback.title).toBe("Good foundation—make the link explicit.");
    expect(feedback.source).toBe("Lecture 5 · slide 18");
  });

  test("separates ATP accounting from the role of NADH", () => {
    const feedback = buildPrototypeCorrection("I think it produces 36 ATP.");

    expect(feedback.title).toBe("Almost—separate the role from the yield.");
    expect(feedback.source).toBe("Lecture 5 · slide 12");
  });
});

describe("sessionReducer", () => {
  test("runs the spoken-answer happy path", () => {
    const requesting = sessionReducer(initialSessionState, { type: "BEGIN" });
    const listening = sessionReducer(requesting, { type: "MIC_GRANTED" });
    const thinking = sessionReducer(listening, { type: "SUBMIT" });
    const correction = sessionReducer(thinking, { type: "EVALUATED" });

    expect(requesting.phase).toBe("requesting");
    expect(listening.phase).toBe("listening");
    expect(thinking.phase).toBe("thinking");
    expect(correction.phase).toBe("correction");
  });

  test("keeps typed recall available when microphone permission is denied", () => {
    const requesting = sessionReducer(initialSessionState, { type: "BEGIN" });
    const blocked = sessionReducer(requesting, {
      message: "Microphone access is off.",
      type: "MIC_DENIED",
    });
    const thinking = sessionReducer(blocked, { type: "SUBMIT" });

    expect(blocked).toEqual({
      phase: "mic-blocked",
      recoveryMessage: "Microphone access is off.",
    });
    expect(thinking.phase).toBe("thinking");
  });

  test("ignores impossible transitions", () => {
    expect(sessionReducer(initialSessionState, { type: "EVALUATED" })).toEqual(initialSessionState);
  });
});
