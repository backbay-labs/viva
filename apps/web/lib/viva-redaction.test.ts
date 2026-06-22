import { describe, expect, test } from "bun:test";
import { redactForVivaLog } from "./viva-redaction";

describe("Viva web redaction controls", () => {
  test("structurally redacts raw learner and auth fields from log payloads", () => {
    const redacted = redactForVivaLog({
      answer_text: "NADH donates electrons to the electron transport chain.",
      answerText: "learner response",
      apiKey: "provider-key",
      pastedText: "source text",
      provider: "cartesia_gemini",
      session_token: "viva1.signed.payload",
      sessionToken: "client token",
      transcript_final: "learner said the raw answer aloud",
    });

    expect(redacted).toEqual({
      answer_text: "[redacted]",
      answerText: "[redacted]",
      apiKey: "[redacted]",
      pastedText: "[redacted]",
      provider: "cartesia_gemini",
      session_token: "[redacted]",
      sessionToken: "[redacted]",
      transcript_final: "[redacted]",
    });
    expect(JSON.stringify(redacted)).not.toContain("NADH");
    expect(JSON.stringify(redacted)).not.toContain("viva1");
    expect(redactForVivaLog({ message: "bearer lower-case-token" })).toEqual({
      message: "[redacted]",
    });
    expect(redactForVivaLog({ protocols: "audio bearer.redacted-token" })).toEqual({
      protocols: "[redacted]",
    });
    expect(redactForVivaLog({ message: "provider prompt included a secret" })).toEqual({
      message: "[redacted]",
    });
  });
});
