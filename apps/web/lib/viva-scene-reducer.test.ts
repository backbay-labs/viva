import { describe, expect, test } from "bun:test";
import type { ManuscriptIntent } from "@viva/core";
import { validateSceneIntentStream, vivaSceneReducer } from "./viva-scene-reducer";

const context = {
  knownEntityIds: ["nadh", "src-lecture-5-slide-18", "hint-1"],
};

describe("vivaSceneReducer", () => {
  test("folds the same intent stream into the same deterministic scene state", () => {
    const intents: ManuscriptIntent[] = [
      { type: "scene_intent", register: "examining", emphasis: "measured" },
      {
        type: "entity_intent",
        entity_id: "nadh",
        entity_kind: "concept",
        register: "correcting",
        emphasis: "marked",
      },
      {
        type: "marginalia_intent",
        marginalia_id: "hint-1",
        anchor_entity_id: "nadh",
        register: "reflecting",
        emphasis: "quiet",
      },
    ];

    expect(vivaSceneReducer(intents, context)).toEqual(vivaSceneReducer(intents, context));
    expect(vivaSceneReducer(intents, context)).toMatchObject({
      register: "examining",
      emphasis: "measured",
      emphasisWeight: 0.55,
      entities: [
        {
          id: "nadh",
          kind: "concept",
          register: "correcting",
          emphasis: "marked",
          emphasisWeight: 0.9,
        },
      ],
      marginalia: [
        {
          id: "hint-1",
          anchorEntityId: "nadh",
          register: "reflecting",
          emphasis: "quiet",
          emphasisWeight: 0.25,
        },
      ],
    });
  });

  test("drops entity and marginalia intents anchored to unknown ids", () => {
    const scene = vivaSceneReducer(
      [
        {
          type: "entity_intent",
          entity_id: "agent-invented-concept",
          entity_kind: "concept",
          register: "correcting",
          emphasis: "marked",
        },
        {
          type: "marginalia_intent",
          marginalia_id: "hint-1",
          anchor_entity_id: "agent-invented-concept",
          register: "reflecting",
          emphasis: "marked",
        },
      ],
      context,
    );

    expect(scene.entities).toEqual([]);
    expect(scene.marginalia).toEqual([]);
  });

  test("validates unknown scene streams without throwing or accepting render instructions", () => {
    const accepted = validateSceneIntentStream([
      { type: "scene_intent", register: "sourcing", emphasis: "quiet" },
      {
        type: "scene_intent",
        register: "sourcing",
        emphasis: "quiet",
        color: "#fff",
      },
      {
        type: "entity_intent",
        entity_id: "<b>nadh</b>",
        entity_kind: "concept",
        register: "examining",
        emphasis: "measured",
      },
      null,
    ]);

    expect(accepted).toEqual([{ type: "scene_intent", register: "sourcing", emphasis: "quiet" }]);
  });
});
