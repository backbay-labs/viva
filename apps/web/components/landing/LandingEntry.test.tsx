import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingEntry, landingEntryTarget } from "./LandingEntry";
import { LandingHero } from "./LandingHero";

type LandingHeroProps = Parameters<typeof LandingHero>[0];

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
    }) as ReactElement<LandingHeroProps>;

    expect(element.type).toBe(LandingHero);
    element.props.onSubmit?.("oxidative phosphorylation");
    element.props.onSuggestion?.("Review missed concepts");

    expect(landingEntryTarget()).toBe("/session");
    expect(intents).toEqual(["oxidative phosphorylation", "Review missed concepts"]);
  });
});
