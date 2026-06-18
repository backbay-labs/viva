import { describe, expect, test } from "bun:test";
import {
  landingSessionTarget,
  librarySessionTarget,
  sessionRouteIdentityFromSearch,
  sessionTokenFromSearch,
} from "./viva-session-entry";

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

  test("builds and parses server-issued library session identity", () => {
    const target = librarySessionTarget({
      sessionId: "server-session",
      sessionToken: "viva1.server-token",
      studySetId: "server-study-set",
      userId: "user-2",
    });

    expect(target).toBe(
      "/session?user_id=user-2&study_set_id=server-study-set&session_id=server-session&session_token=viva1.server-token",
    );
    expect(sessionRouteIdentityFromSearch(target.slice("/session".length))).toEqual({
      sessionId: "server-session",
      sessionToken: "viva1.server-token",
      studySetId: "server-study-set",
      userId: "user-2",
    });
  });
});
