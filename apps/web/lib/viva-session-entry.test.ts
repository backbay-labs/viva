import { describe, expect, test } from "bun:test";
import { landingSessionTarget, sessionTokenFromSearch } from "./viva-session-entry";

describe("session entry routing", () => {
  test("preserves signed session tokens when crossing from landing into session", () => {
    expect(landingSessionTarget("?session_token=signed-session-token")).toBe(
      "/session?session_token=signed-session-token",
    );
    expect(landingSessionTarget("?token=alternate-token")).toBe(
      "/session?session_token=alternate-token",
    );
  });

  test("does not invent a session token when none is supplied", () => {
    expect(landingSessionTarget("?q=oxidative+phosphorylation")).toBe("/session");
    expect(sessionTokenFromSearch("?session_token=%20%20")).toBe(null);
  });
});
