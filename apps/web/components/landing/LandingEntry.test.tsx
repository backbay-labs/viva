import { describe, expect, test } from "bun:test";
import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VivaLibrarySnapshot } from "../../lib/viva-library";
import { LandingEntry, landingEntryTarget } from "./LandingEntry";
import { LandingHero } from "./LandingHero";

type LandingHeroProps = Parameters<typeof LandingHero>[0];

const librarySnapshot: VivaLibrarySnapshot = {
  user_id: "user-1",
  privacy: {
    copy: "Voice recordings and transcripts are not saved; Viva stores sanitized study meaning only.",
    export: { available: true, control_token: "viva1.control-token" },
    export_contains_raw_provider_payloads: false,
    raw_audio_persistence: false,
    transcript_persistence: false,
    transcripts_saved: false,
    voice_recordings_saved: false,
  },
  study_sets: [
    {
      id: "biology-midterm",
      user_id: "user-1",
      title: "Biology Midterm",
      course: "Biology 201",
      ingestion_status: "ready",
      ingestion_error: null,
      server_owned: true,
      documents: [
        {
          id: "lec-5",
          display_name: "Lecture 5",
          source_kind: "pdf",
          processing_status: "ready",
          deleted: false,
        },
      ],
      concept_count: 2,
      question_count: 1,
      actions: {
        start: {
          available: true,
          session_id: "server-session",
          session_token: "viva1.server-token",
        },
        resume: { available: false, unavailable_reason: "no_open_session" },
        archive: { available: false, unavailable_reason: "server_mutation_unavailable" },
        delete: { available: true, control_token: "viva1.control-token" },
      },
    },
  ],
  sessions: [
    {
      voice_session_id: "voice-session-1",
      user_id: "user-1",
      study_set_id: "biology-midterm",
      study_set_title: "Biology Midterm",
      status: "closed",
      terminal_reason: "completed",
      recap: {
        voice_session_id: "voice-session-1",
        strong_concepts: ["oxidative-phosphorylation"],
        shaky_concepts: ["nadh"],
        missed_concepts: [],
        review_later: ["nadh"],
      },
      next_review: {
        concept_id: "nadh",
        label: "NADH",
        status: "shaky",
        persisted_due_at: "2026-06-19T09:00:00Z",
        source: "persisted_review_item",
      },
    },
  ],
};

describe("LandingEntry", () => {
  test("renders the hero without mounting the legacy study app", () => {
    const markup = renderToStaticMarkup(<LandingEntry onEnter={() => {}} />);

    expect(markup).toContain("All you must know,");
    expect(markup).toContain("Where should Viva begin?");
    expect(markup).not.toContain("What are we studying?");
    expect(markup).not.toContain("Generate local preview");
  });

  test("routes command and suggestion directly to the single session entrypoint", () => {
    const intents: string[] = [];
    const element = LandingEntry({
      onEnter: (intent) => intents.push(intent),
    }) as ReactElement<{ children: ReactElement[] }>;
    const hero = Children.toArray(element.props.children).find(
      (child): child is ReactElement<LandingHeroProps> =>
        typeof child === "object" &&
        child !== null &&
        "type" in child &&
        child.type === LandingHero,
    );

    expect(hero?.type).toBe(LandingHero);
    hero?.props.onSubmit?.("oxidative phosphorylation");
    hero?.props.onSuggestion?.("Review missed concepts");

    expect(landingEntryTarget()).toBe("/session");
    expect(intents).toEqual(["oxidative phosphorylation", "Review missed concepts"]);
  });

  test("renders server-owned library and completed session history when provided", () => {
    const markup = renderToStaticMarkup(
      <LandingEntry initialLibrarySnapshot={librarySnapshot} onEnter={() => {}} />,
    );

    expect(markup).toContain("Library");
    expect(markup).toContain("Privacy controls");
    expect(markup).toContain("Voice recordings and transcripts are not saved");
    expect(markup).toContain("Export data");
    expect(markup).toContain("Biology Midterm");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Start");
    expect(markup).toContain("Delete source");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Completed");
    expect(markup).toContain("Delete recap");
    expect(markup).toContain("NADH");
    expect(markup).toContain("server schedule");
    expect(markup).toContain(
      "/session?user_id=user-1&amp;study_set_id=biology-midterm&amp;session_id=server-session&amp;session_token=viva1.server-token",
    );
  });

  test("session cards surface a mastery ring, emphasise the next drill, and quiet the delete", () => {
    const markup = renderToStaticMarkup(
      <LandingEntry initialLibrarySnapshot={librarySnapshot} onEnter={() => {}} />,
    );

    // The completed session recap (1 strong / 1 shaky) rings its held share,
    // captioned so the bare percentage never reads as overall mastery.
    expect(markup).toContain("mastery-ring");
    expect(markup).toContain("viva-library__mastery-caption");
    // The persisted next review reads as the card's next action, not flat metadata.
    expect(markup).toContain("Next drill");
    expect(markup).toContain("server schedule");
    // Destructive actions are demoted to a quiet danger affordance.
    expect(markup).toContain("viva-library__action--danger");
    // The study-set primary action keeps its emphasis.
    expect(markup).toContain("viva-library__action--primary");
  });
});
