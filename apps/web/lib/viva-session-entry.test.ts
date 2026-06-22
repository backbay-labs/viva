import { describe, expect, test } from "bun:test";
import {
  canonicalSessionLocation,
  landingSessionTarget,
  librarySessionTarget,
  sessionRouteIdentityFromLocationParts,
  sessionTokenFromLocationParts,
  sessionTokenFromSearch,
} from "./viva-session-entry";

describe("session entry routing", () => {
  test("moves signed session tokens into fragments when crossing into session", () => {
    expect(landingSessionTarget("?session_token=signed-session-token")).toBe(
      "/session#session_token=signed-session-token",
    );
    expect(landingSessionTarget("?token=alternate-token")).toBe(
      "/session#session_token=alternate-token",
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
      "/session?user_id=user-2&study_set_id=server-study-set&session_id=server-session#session_token=viva1.server-token",
    );
    const [search = "", hash = ""] = target.slice("/session".length).split("#");
    expect(sessionRouteIdentityFromLocationParts(search, `#${hash}`)).toEqual({
      sessionId: "server-session",
      sessionToken: "viva1.server-token",
      studySetId: "server-study-set",
      userId: "user-2",
    });
  });

  test("parses legacy query tokens and fragment tokens without putting tokens in canonical URLs", () => {
    expect(
      sessionTokenFromLocationParts(
        "?user_id=user-2&session_token=viva1.query-token",
        "#session_token=viva1.fragment-token",
      ),
    ).toBe("viva1.query-token");
    expect(sessionTokenFromLocationParts("?user_id=user-2", "#token=viva1.fragment-token")).toBe(
      "viva1.fragment-token",
    );
    expect(
      sessionRouteIdentityFromLocationParts(
        "?user_id=user-2&study_set_id=set-1&session_id=session-1",
        "#session_token=viva1.fragment-token",
      ),
    ).toEqual({
      sessionId: "session-1",
      sessionToken: "viva1.fragment-token",
      studySetId: "set-1",
      userId: "user-2",
    });
    expect(
      canonicalSessionLocation(
        "/session",
        "?user_id=user-2&study_set_id=set-1&session_token=viva1.query-token",
        "#session_token=viva1.fragment-token",
      ),
    ).toBe("/session?user_id=user-2&study_set_id=set-1");
    expect(canonicalSessionLocation("/session", "?session_token=viva1.query-token", "")).toBe(
      "/session",
    );
    expect(canonicalSessionLocation("/session", "", "#session_token=%20%20")).toBe("/session");
    expect(canonicalSessionLocation("/session", "?user_id=user-2", "#section")).toBe(
      "/session?user_id=user-2#section",
    );
  });
});
