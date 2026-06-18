import type {
  ManuscriptEmphasis,
  ManuscriptEntityKind,
  ManuscriptIntent,
  ManuscriptRegister,
} from "@viva/core";

export type VivaSceneContext = {
  knownEntityIds: readonly string[];
};

export type VivaSceneEntity = {
  id: string;
  kind: ManuscriptEntityKind;
  register: ManuscriptRegister;
  emphasis: ManuscriptEmphasis;
  emphasisWeight: number;
};

export type VivaSceneMarginalia = {
  id: string;
  anchorEntityId: string;
  register: ManuscriptRegister;
  emphasis: ManuscriptEmphasis;
  emphasisWeight: number;
};

export type VivaSceneState = {
  register: ManuscriptRegister;
  emphasis: ManuscriptEmphasis;
  emphasisWeight: number;
  entities: VivaSceneEntity[];
  marginalia: VivaSceneMarginalia[];
};

const DEFAULT_SCENE: VivaSceneState = {
  register: "examining",
  emphasis: "quiet",
  emphasisWeight: 0.25,
  entities: [],
  marginalia: [],
};

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const MAX_ID_LENGTH = 96;

export function emphasisWeight(emphasis: ManuscriptEmphasis): number {
  switch (emphasis) {
    case "marked":
      return 0.9;
    case "measured":
      return 0.55;
    case "quiet":
      return 0.25;
  }
}

export function validateSceneIntentStream(value: unknown): ManuscriptIntent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((intent) => {
    const valid = validateSceneIntent(intent);
    return valid ? [valid] : [];
  });
}

export function vivaSceneReducer(
  intents: readonly ManuscriptIntent[],
  context: VivaSceneContext,
): VivaSceneState {
  const known = new Set(context.knownEntityIds);
  let scene: VivaSceneState = { ...DEFAULT_SCENE, entities: [], marginalia: [] };

  for (const intent of validateSceneIntentStream(intents)) {
    switch (intent.type) {
      case "scene_intent":
        scene = {
          ...scene,
          register: intent.register,
          emphasis: intent.emphasis,
          emphasisWeight: emphasisWeight(intent.emphasis),
        };
        break;
      case "entity_intent":
        if (!known.has(intent.entity_id)) break;
        scene = {
          ...scene,
          entities: upsertById(scene.entities, {
            id: intent.entity_id,
            kind: intent.entity_kind,
            register: intent.register,
            emphasis: intent.emphasis,
            emphasisWeight: emphasisWeight(intent.emphasis),
          }),
        };
        break;
      case "marginalia_intent":
        if (!known.has(intent.marginalia_id) || !known.has(intent.anchor_entity_id)) break;
        scene = {
          ...scene,
          marginalia: upsertById(scene.marginalia, {
            id: intent.marginalia_id,
            anchorEntityId: intent.anchor_entity_id,
            register: intent.register,
            emphasis: intent.emphasis,
            emphasisWeight: emphasisWeight(intent.emphasis),
          }),
        };
        break;
    }
  }

  return scene;
}

function upsertById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  const existing = items.findIndex((item) => item.id === next.id);
  if (existing === -1) return [...items, next];
  return items.map((item, index) => (index === existing ? next : item));
}

function validateSceneIntent(value: unknown): ManuscriptIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "scene_intent":
      if (!hasOnlyKeys(record, ["type", "register", "emphasis"])) return null;
      if (!isRegister(record.register) || !isEmphasis(record.emphasis)) return null;
      return {
        type: "scene_intent",
        register: record.register,
        emphasis: record.emphasis,
      };
    case "entity_intent":
      if (!hasOnlyKeys(record, ["type", "entity_id", "entity_kind", "register", "emphasis"])) {
        return null;
      }
      if (
        !isIntentId(record.entity_id) ||
        !isEntityKind(record.entity_kind) ||
        !isRegister(record.register) ||
        !isEmphasis(record.emphasis)
      ) {
        return null;
      }
      return {
        type: "entity_intent",
        entity_id: record.entity_id,
        entity_kind: record.entity_kind,
        register: record.register,
        emphasis: record.emphasis,
      };
    case "marginalia_intent":
      if (
        !hasOnlyKeys(record, [
          "type",
          "marginalia_id",
          "anchor_entity_id",
          "register",
          "emphasis",
        ])
      ) {
        return null;
      }
      if (
        !isIntentId(record.marginalia_id) ||
        !isIntentId(record.anchor_entity_id) ||
        !isRegister(record.register) ||
        !isEmphasis(record.emphasis)
      ) {
        return null;
      }
      return {
        type: "marginalia_intent",
        marginalia_id: record.marginalia_id,
        anchor_entity_id: record.anchor_entity_id,
        register: record.register,
        emphasis: record.emphasis,
      };
    default:
      return null;
  }
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function isIntentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    ID_RE.test(value)
  );
}

function isRegister(value: unknown): value is ManuscriptRegister {
  return (
    value === "examining" ||
    value === "reflecting" ||
    value === "correcting" ||
    value === "sourcing" ||
    value === "recapping"
  );
}

function isEmphasis(value: unknown): value is ManuscriptEmphasis {
  return value === "quiet" || value === "measured" || value === "marked";
}

function isEntityKind(value: unknown): value is ManuscriptEntityKind {
  return value === "concept" || value === "source" || value === "marginal_note";
}
