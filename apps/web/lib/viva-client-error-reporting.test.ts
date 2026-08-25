import { describe, expect, test } from "bun:test";
import {
  reportVivaClientRenderError,
  safeVivaErrorReference,
  type VivaClientRenderErrorReport,
} from "./viva-client-error-reporting";

const HOSTILE_MESSAGE =
  "render failed near https://evil.invalid/?session_token=viva1.hostile#state=HOSTILE_STATE_SENTINEL with Bearer HOSTILE_BEARER";

function hostileError(digest: string | undefined): Error & { digest?: string } {
  const error = new Error(HOSTILE_MESSAGE) as Error & { digest?: string };
  error.stack = `Error: HOSTILE_STATE_SENTINEL\n    at https://evil.invalid/hostile\n    at Object.<anonymous>`;
  error.cause = new Error("caused by Bearer HOSTILE_BEARER HOSTILE_STATE_SENTINEL");
  if (digest !== undefined) error.digest = digest;
  return error;
}

describe("safeVivaErrorReference", () => {
  test("accepts a well-formed digest unmodified", () => {
    expect(safeVivaErrorReference("SAFE_REF_42")).toBe("SAFE_REF_42");
  });

  test("accepts every character in the allowed alphabet at the 64-character boundary", () => {
    const boundary = "aZ09_-".repeat(11).slice(0, 64);
    expect(boundary).toHaveLength(64);
    expect(safeVivaErrorReference(boundary)).toBe(boundary);
  });

  test("rejects a digest one character over the 64-character boundary", () => {
    const overlong = "a".repeat(65);
    expect(safeVivaErrorReference(overlong)).toBe(null);
  });

  test("rejects an empty string", () => {
    expect(safeVivaErrorReference("")).toBe(null);
  });

  test("rejects a digest containing characters outside the allowlist", () => {
    expect(safeVivaErrorReference("ref with spaces")).toBe(null);
    expect(safeVivaErrorReference("ref:with:colons")).toBe(null);
    expect(
      safeVivaErrorReference("https://evil.invalid/?session_token=viva1.hostile#state=x"),
    ).toBe(null);
    expect(safeVivaErrorReference("Bearer HOSTILE_BEARER")).toBe(null);
  });

  test("rejects non-string input rather than coercing it", () => {
    expect(safeVivaErrorReference(undefined)).toBe(null);
    expect(safeVivaErrorReference(null)).toBe(null);
    expect(safeVivaErrorReference(42)).toBe(null);
    expect(safeVivaErrorReference({ toString: () => "SAFE_REF_42" })).toBe(null);
  });
});

describe("reportVivaClientRenderError", () => {
  test("emits exactly the two-key report contract for a valid digest", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const error = hostileError("SAFE_REF_42");
    reportVivaClientRenderError(error, (report) => reports.push(report));
    expect(reports).toEqual([{ event: "viva_client_render_error", reference: "SAFE_REF_42" }]);
  });

  test("never reads message/stack/cause/name into the report", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const error = hostileError("SAFE_REF_42");
    reportVivaClientRenderError(error, (report) => reports.push(report));
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("HOSTILE_STATE_SENTINEL");
    expect(serialized).not.toContain("HOSTILE_BEARER");
    expect(serialized).not.toContain("evil.invalid");
    expect(serialized).not.toContain("session_token");
    expect(Object.keys(reports[0] ?? {})).toEqual(["event", "reference"]);
  });

  test("a malformed digest reports reference: null, never a partial value", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const error = hostileError("not a valid ref!!");
    reportVivaClientRenderError(error, (report) => reports.push(report));
    expect(reports).toEqual([{ event: "viva_client_render_error", reference: null }]);
  });

  test("an overlong digest reports reference: null", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const error = hostileError("a".repeat(65));
    reportVivaClientRenderError(error, (report) => reports.push(report));
    expect(reports).toEqual([{ event: "viva_client_render_error", reference: null }]);
  });

  test("reports reference: null when no digest is present", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const error = hostileError(undefined);
    reportVivaClientRenderError(error, (report) => reports.push(report));
    expect(reports).toEqual([{ event: "viva_client_render_error", reference: null }]);
  });

  test("deduplicates by error object identity: the same Error reports at most once", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const error = hostileError("SAFE_REF_42");
    const sink = (report: VivaClientRenderErrorReport) => reports.push(report);
    reportVivaClientRenderError(error, sink);
    reportVivaClientRenderError(error, sink);
    reportVivaClientRenderError(error, sink);
    expect(reports).toHaveLength(1);
  });

  test("a distinct Error object, even with identical message and digest, reports again", () => {
    const reports: VivaClientRenderErrorReport[] = [];
    const sink = (report: VivaClientRenderErrorReport) => reports.push(report);
    const errorA = hostileError("SAFE_REF_42");
    const errorB = hostileError("SAFE_REF_42");
    reportVivaClientRenderError(errorA, sink);
    reportVivaClientRenderError(errorB, sink);
    expect(reports).toEqual([
      { event: "viva_client_render_error", reference: "SAFE_REF_42" },
      { event: "viva_client_render_error", reference: "SAFE_REF_42" },
    ]);
  });

  test("marks the error reported before invoking the sink, so a throwing sink is never retried with raw data", () => {
    let sinkCalls = 0;
    const error = hostileError("SAFE_REF_42");
    const throwingSink = () => {
      sinkCalls += 1;
      throw new Error("sink is down");
    };
    expect(() => reportVivaClientRenderError(error, throwingSink)).not.toThrow();
    // A caller retrying after the sink threw (e.g. an effect re-running)
    // must not cause a second sink invocation for the same error.
    reportVivaClientRenderError(error, throwingSink);
    expect(sinkCalls).toBe(1);
  });

  test("uses console.error as the default sink, logging only the structured report", () => {
    const error = hostileError("SAFE_REF_42");
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      reportVivaClientRenderError(error);
    } finally {
      console.error = original;
    }
    expect(calls).toEqual([[{ event: "viva_client_render_error", reference: "SAFE_REF_42" }]]);
  });
});
