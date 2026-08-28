// RELEASE-030 E2E extraction, further split (post-review-remediation amend):
// page-action, diagnostic-redaction, and session/websocket protocol-boundary
// helpers. Derived from `e2e-browser-story.mjs` -- see that file's own header
// for why it now has five siblings instead of standing alone. None of these
// close over per-run state; every dependency is an explicit parameter.
import {
  RELEASE_VOICE_SERVER_FRAME_INVALID,
  ReleaseContractValidationError,
  releaseProtocolVersionFromServerFrame,
  validatedVoiceFrameForRelease,
} from "./release-contract-validation.mjs";

export function redactSensitiveDiagnostic(value) {
  return String(value)
    .replace(/#session_token=[^\s"'<>)]*/gi, "#redacted-session-fragment")
    .replace(/[?&]session_token=[^&\s"'<>)]*/gi, "?redacted_session_param=1")
    .replace(/viva1\.[A-Za-z0-9._-]+/g, "redacted-viva-token")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer redacted");
}

export async function isVisible(locator) {
  try {
    return await locator.isVisible({ timeout: 1_000 });
  } catch {
    return false;
  }
}

export function conceptStatusText(status) {
  switch (status) {
    case "strong":
      return "Strong";
    case "shaky":
      return "Shaky";
    case "missed":
      return "Missed";
    case "review":
      return "Review";
    default:
      return "Awaiting concept status";
  }
}

export function conceptLabelText(conceptId) {
  const labels = {
    "atp-synthase": "ATP synthase",
    "cellular-respiration": "Cellular respiration",
    glycolysis: "Glycolysis",
    "krebs-cycle": "Krebs cycle",
    nadh: "NADH",
    "oxidative-phosphorylation": "Oxidative phosphorylation",
    photosynthesis: "Photosynthesis",
  };
  if (!conceptId || !labels[conceptId]) {
    throw new Error(`No canonical recap label is known for concept_id: ${conceptId ?? "missing"}`);
  }
  return labels[conceptId];
}

export function bootstrapToken(label) {
  return encodeURIComponent(`redacted-${label}-bootstrap`);
}

export async function waitForCanonicalSessionUrl(targetPage, id) {
  await targetPage.waitForFunction(
    () => {
      const tokenParamNames = ["session_token", "token"];
      const searchParams = new URLSearchParams(location.search);
      const rawHash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
      const hashParams = rawHash.includes("=")
        ? new URLSearchParams(rawHash)
        : new URLSearchParams();
      return (
        location.pathname === "/session" &&
        tokenParamNames.every((name) => !searchParams.has(name) && !hashParams.has(name))
      );
    },
    undefined,
    { timeout: 10_000 },
  );
  const state = await targetPage.evaluate(() => {
    const tokenParamNames = ["session_token", "token"];
    const searchParams = new URLSearchParams(location.search);
    const rawHash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    const hashParams = rawHash.includes("=") ? new URLSearchParams(rawHash) : new URLSearchParams();
    return {
      pathname: location.pathname,
      token_param_visible: tokenParamNames.some(
        (name) => searchParams.has(name) || hashParams.has(name),
      ),
    };
  });
  if (state.pathname !== "/session" || state.token_param_visible) {
    throw new Error(`Session URL canonicalization failed for ${id}.`);
  }
  return { id, token_param_visible: state.token_param_visible };
}

async function redactLocatorText(locator, replacement) {
  if ((await locator.count()) === 0) return;
  await locator.evaluate((element, text) => {
    element.textContent = text;
  }, replacement);
}

async function redactStudentHandForSanitizedScreenshot(targetPage) {
  await redactLocatorText(
    targetPage.locator(".student-hand p").first(),
    "Student answer redacted in sanitized browser-story artifact.",
  );
}

export async function redactSourceFolioForSanitizedScreenshot(targetPage) {
  await redactStudentHandForSanitizedScreenshot(targetPage);
  await redactLocatorText(
    targetPage.locator(".source-folio__excerpt p").first(),
    "Bounded source excerpt redacted in sanitized browser-story artifact.",
  );
}

export async function redactCorrectionMarginaliaForSanitizedScreenshot(targetPage) {
  await redactStudentHandForSanitizedScreenshot(targetPage);
  await redactLocatorText(
    targetPage.locator(".correction__body").first(),
    "Learner-answer reference redacted in sanitized browser-story artifact.",
  );
  await redactLocatorText(
    targetPage.locator(".correction__explain").first(),
    "Source-grounded model explanation redacted in sanitized browser-story artifact.",
  );
}

export async function redactRecapForSanitizedScreenshot(targetPage) {
  await redactStudentHandForSanitizedScreenshot(targetPage);
  await redactLocatorText(
    targetPage.locator(".recap-fold .folio__excerpt").first(),
    "Session recap summary redacted in sanitized browser-story artifact.",
  );
  const sourceFooters = await targetPage.locator(".recap-fold .folio__footer").all();
  if (sourceFooters.length > 0) {
    await redactLocatorText(
      sourceFooters[0],
      "Bounded source moment redacted in sanitized browser-story artifact.",
    );
  }
}


export async function fetchSignedSessionStartTarget(targetPage, identity) {
  return targetPage.evaluate(async ({ userId, studySetId }) => {
    const libraryParams = new URLSearchParams({ user_id: userId });
    const response = await fetch(
      `/api/viva-library/study-sets/library?${libraryParams.toString()}`,
      {
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(`hosted library action fetch failed with HTTP ${response.status}`);
    }
    const snapshot = await response.json();
    const studySet = snapshot.study_sets?.find((entry) => entry.id === studySetId);
    const action = studySet?.actions?.start;
    if (!studySet?.user_id || !action?.session_bootstrap_token) {
      throw new Error("hosted library action fetch did not return a bootstrap capability");
    }
    const startResponse = await fetch("/api/viva-session/start", {
      body: JSON.stringify({
        session_bootstrap_token: action.session_bootstrap_token,
        study_set_id: studySet.id,
        user_id: studySet.user_id,
      }),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!startResponse.ok) {
      throw new Error(`hosted session bootstrap failed with HTTP ${startResponse.status}`);
    }
    const sessionPayload = await startResponse.json();
    if (
      !sessionPayload?.session?.session_id ||
      !sessionPayload.session.study_set_id ||
      !sessionPayload.session.user_id ||
      !sessionPayload.session_token
    ) {
      throw new Error("hosted session bootstrap did not return a signed session token");
    }
    const params = new URLSearchParams({
      user_id: sessionPayload.session.user_id,
      study_set_id: sessionPayload.session.study_set_id,
      session_id: sessionPayload.session.session_id,
    });
    return `/session?${params.toString()}#session_token=${encodeURIComponent(
      sessionPayload.session_token,
    )}`;
  }, identity);
}

export async function submitWrittenAnswerIfFallbackOpens(targetPage) {
  const answerInput = targetPage.getByRole("textbox", { name: "Student written answer" });
  if (!(await isVisible(answerInput))) return false;
  await answerInput.fill("NADH donates electrons to the electron transport chain.");
  await targetPage.getByRole("button", { name: "Submit written answer" }).click();
  return true;
}

export function normalizeComparableWsUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/g, "");
}

function redactedWebSocketUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/g, "");
}

export function assertHostedWebSocketTarget(urls, expectedUrl) {
  const expected = normalizeComparableWsUrl(expectedUrl);
  const observed = urls.map(normalizeComparableWsUrl);
  if (!observed.includes(expected)) {
    throw new Error(
      `Hosted browser E2E did not connect to configured agent WebSocket. Expected ${expected}; observed ${
        observed.map(redactedWebSocketUrl).join(", ") || "none"
      }`,
    );
  }
}

/**
 * RELEASE-028 / A-03: build the failure-control replay's client frames from the
 * protocol version the *server* advertised in its own validated `ready` frame.
 *
 * The recorded latent defect closed here: this path hand-wrote a
 * `session_config` frame at a local literal version and without
 * `client_generation_id`, so on a v5 server it was a v4 frame that would be
 * refused outright — invisible because the default release run never enables
 * the harness. There is no literal left to drift and no second schema: an
 * unacceptable ready frame throws before any client frame exists.
 */
export function failureControlReplayClientFrames({ readyFrame, clientGenerationId, session }) {
  // The version is negotiated, so it may only come from the server's own
  // `ready` frame — not from whatever frame happened to arrive first.
  if (validatedVoiceFrameForRelease(readyFrame).type !== "ready") {
    throw new ReleaseContractValidationError(RELEASE_VOICE_SERVER_FRAME_INVALID);
  }
  const protocolVersion = releaseProtocolVersionFromServerFrame(readyFrame);
  return {
    protocolVersion,
    sessionConfig: {
      type: "session_config",
      version: protocolVersion,
      client_generation_id: clientGenerationId,
      session_token: session.sessionToken,
      session: {
        session_id: session.sessionId,
        user_id: session.userId,
        study_set_id: session.studySetId,
        mode: "quiz",
        source_context: [],
        active_concepts: [],
      },
    },
  };
}
