import { describe, expect, test } from "bun:test";
import { parseVivaServerFrame, type SessionRecap, seedStudySets } from "@viva/core";
import { recapModel } from "@/agent/recap-view-model";
import { agentRecapToSessionRecap } from "@/agent/shared-web";
import fixture from "../../../../agent/fixtures/voice-protocol/synthetic-study-session.json";

const NOW = new Date("2026-06-17T12:00:00.000Z");

describe("recapModel", () => {
  test("projects the canonical session fixture through concept events and core FSRS", () => {
    const recap = fixtureRecap();
    const model = recapModel({
      conceptStatuses: { nadh: "shaky" },
      now: NOW,
      recap,
      studySet: seedStudySets[0],
    });

    expect(model).toMatchObject({
      headline: "Oxidative phosphorylation is getting stronger.",
      ledger: [
        { colorToken: "sageDeep", count: 2, label: "strong" },
        { colorToken: "ochre", count: 1, label: "shaky" },
        { colorToken: "plumVivid", count: 1, label: "tomorrow" },
      ],
      nextReview: { label: "NADH", when: "tomorrow" },
      summary:
        "You named NADH as the electron donor in biology-midterm. Next, make the proton-gradient-to-ATP-synthase link explicit.",
    });
    expect(model.moments).toEqual([
      {
        detail:
          "NADH donates high-energy electrons to the electron transport chain. Electron flow pumps protons across the inner mitochondrial membrane, creating the gradient that drives ATP synthase.",
        key: "src-lecture-5-slide-18:slide:18:0",
        source: "Lecture 5 · Slide 18",
        title: "NADH donates high-energy electrons to the electron transport chain.",
      },
    ]);
    expect(model.partialReasonCopy).toBeUndefined();
  });

  test("reports a time-cap partial recap without presenting it as complete", () => {
    const model = recapModel({
      conceptStatuses: { nadh: "shaky" },
      now: NOW,
      partialReason: "turn_cap",
      recap: fixtureRecap(),
      studySet: seedStudySets[0],
    });

    expect(model.partialReasonCopy).toBe(
      "The session ended early (time cap). This recap covers what was completed.",
    );
  });

  test("fails closed when recap or study-set scheduling evidence is absent", () => {
    expect(
      recapModel({
        conceptStatuses: {},
        now: NOW,
      }),
    ).toEqual({
      headline: "No finished session yet",
      ledger: [
        { colorToken: "sageDeep", count: 0, label: "strong" },
        { colorToken: "ochre", count: 0, label: "shaky" },
        { colorToken: "plumVivid", count: 0, label: "tomorrow" },
      ],
      moments: [],
      summary: "Finish a session to see its source-grounded recap here.",
    });

    const withoutStudySet = recapModel({
      conceptStatuses: { nadh: "shaky" },
      now: NOW,
      recap: fixtureRecap(),
    });
    expect(withoutStudySet.nextReview).toBeUndefined();
    expect(withoutStudySet.ledger.map((item) => item.count)).toEqual([2, 1, 1]);

    const metadataOnlyStudySet = recapModel({
      conceptStatuses: { nadh: "shaky" },
      now: NOW,
      recap: fixtureRecap(),
      studySet: { ...seedStudySets[0], concepts: [] },
    });
    expect(metadataOnlyStudySet.nextReview).toBeUndefined();
    expect(metadataOnlyStudySet.ledger.map((item) => item.count)).toEqual([2, 1, 1]);
  });

  test("accepts terminalReason as a compatibility source for honest partial copy", () => {
    const model = recapModel({
      conceptStatuses: {},
      now: NOW,
      recap: fixtureRecap(),
      terminalReason: "provider_timeout",
    });

    expect(model.partialReasonCopy).toBe(
      "The session ended early (provider timeout). This recap covers what was completed.",
    );
  });

  test("reports a terminal-only result without claiming that a recap exists", () => {
    expect(
      recapModel({
        conceptStatuses: {},
        now: NOW,
        studySet: seedStudySets[0],
        terminalReason: "durability_degraded",
      }),
    ).toMatchObject({
      headline: "Session ended before recap",
      partialReasonCopy:
        "The session ended early (storage degradation). No source-grounded recap was returned.",
      summary: "Nothing has been presented as completed or scheduled.",
    });
  });
});

function fixtureRecap(): SessionRecap {
  for (const frame of fixture.server) {
    const parsed = parseVivaServerFrame(frame);
    if (parsed.type === "event" && parsed.event.type === "recap_ready") {
      return agentRecapToSessionRecap(parsed.event.recap);
    }
  }

  throw new Error("Canonical synthetic fixture is missing recap_ready");
}
