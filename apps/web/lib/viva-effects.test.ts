import { describe, expect, test } from "bun:test";
import type { VivaEffectsPolicy, VivaEffectsPolicyInput } from "./viva-effects";
import {
  readVivaEffectsPreference,
  resolveVivaEffectsPolicy,
  VIVA_EFFECTS_CHANGE_EVENT,
  VIVA_EFFECTS_PREFERENCE_STORAGE_KEY,
} from "./viva-effects";

const STATIC_POLICY: VivaEffectsPolicy = {
  mode: "static",
  dprCap: 1.5,
  fps: 0,
  glyphCountScale: 0.5,
};

const REDUCED_POLICY: VivaEffectsPolicy = {
  mode: "reduced",
  dprCap: 1.5,
  fps: 24,
  glyphCountScale: 0.5,
};

const FULL_POLICY: VivaEffectsPolicy = {
  mode: "full",
  dprCap: 2,
  fps: 32,
  glyphCountScale: 1,
};

/**
 * High-end, no-reduction baseline: absent any overrides this resolves to
 * `FULL_POLICY`. Every table row overrides only the fields relevant to the
 * rule it exercises so a failure names exactly one precedence row.
 */
function baseInput(overrides: Partial<VivaEffectsPolicyInput> = {}): VivaEffectsPolicyInput {
  return {
    canvasRole: "voice_trace",
    viewportWidth: 1280,
    viewportHeight: 720,
    devicePixelRatio: 2,
    hardwareConcurrency: 8,
    prefersReducedMotion: false,
    prefersReducedTransparency: false,
    saveData: false,
    explicitPreference: null,
    ...overrides,
  };
}

type PolicyRow = {
  name: string;
  overrides: Partial<VivaEffectsPolicyInput>;
  expected: VivaEffectsPolicy;
};

const POLICY_TABLE: PolicyRow[] = [
  {
    name: "session_muse forces static even with high-end hardware and no reduced signals",
    overrides: { canvasRole: "session_muse", hardwareConcurrency: 16, saveData: false },
    expected: STATIC_POLICY,
  },
  {
    name: "session_muse stays static even when a reduced-tier hardware signal also applies",
    overrides: {
      canvasRole: "session_muse",
      hardwareConcurrency: 2,
      saveData: true,
      prefersReducedMotion: true,
    },
    expected: STATIC_POLICY,
  },
  {
    name: "prefersReducedMotion alone forces static",
    overrides: { canvasRole: "voice_trace", prefersReducedMotion: true },
    expected: STATIC_POLICY,
  },
  {
    name: "prefersReducedTransparency alone forces static",
    overrides: { canvasRole: "landing_muse", prefersReducedTransparency: true },
    expected: STATIC_POLICY,
  },
  {
    name: "explicitPreference reduced alone forces static",
    overrides: { canvasRole: "landing_muse", explicitPreference: "reduced" },
    expected: STATIC_POLICY,
  },
  {
    name: "static precedence wins over a simultaneous low-end-hardware/Save-Data signal",
    overrides: {
      canvasRole: "voice_trace",
      prefersReducedMotion: true,
      hardwareConcurrency: 2,
      saveData: true,
    },
    expected: STATIC_POLICY,
  },
  {
    name: "hardwareConcurrency at the 4-core boundary is reduced",
    overrides: { hardwareConcurrency: 4, saveData: false },
    expected: REDUCED_POLICY,
  },
  {
    name: "hardwareConcurrency below the boundary is reduced",
    overrides: { hardwareConcurrency: 2, saveData: false },
    expected: REDUCED_POLICY,
  },
  {
    name: "saveData alone is reduced even on high-end hardware",
    overrides: { hardwareConcurrency: 16, saveData: true },
    expected: REDUCED_POLICY,
  },
  {
    name: "saveData combined with unknown hardwareConcurrency is reduced",
    overrides: { hardwareConcurrency: null, saveData: true },
    expected: REDUCED_POLICY,
  },
  {
    name: "unknown hardwareConcurrency is not treated as low-end",
    overrides: { hardwareConcurrency: null, saveData: false },
    expected: FULL_POLICY,
  },
  {
    name: "hardwareConcurrency just above the boundary is full",
    overrides: { hardwareConcurrency: 5, saveData: false },
    expected: FULL_POLICY,
  },
  {
    name: "high hardwareConcurrency with no reduced signals is full",
    overrides: { canvasRole: "landing_muse", hardwareConcurrency: 32, saveData: false },
    expected: FULL_POLICY,
  },
];

describe("resolveVivaEffectsPolicy", () => {
  for (const row of POLICY_TABLE) {
    test(row.name, () => {
      expect(resolveVivaEffectsPolicy(baseInput(row.overrides))).toEqual(row.expected);
    });
  }

  test("returns the exact locked policy shape for each mode", () => {
    expect(resolveVivaEffectsPolicy(baseInput({ canvasRole: "session_muse" }))).toEqual({
      mode: "static",
      dprCap: 1.5,
      fps: 0,
      glyphCountScale: 0.5,
    });
    expect(
      resolveVivaEffectsPolicy(baseInput({ hardwareConcurrency: 4, saveData: false })),
    ).toEqual({ mode: "reduced", dprCap: 1.5, fps: 24, glyphCountScale: 0.5 });
    expect(
      resolveVivaEffectsPolicy(baseInput({ hardwareConcurrency: 8, saveData: false })),
    ).toEqual({ mode: "full", dprCap: 2, fps: 32, glyphCountScale: 1 });
  });
});

type FakeStorageBehavior = { value?: string | null; throwOnGet?: boolean };

function fakeStorage(behavior: FakeStorageBehavior = {}): {
  storage: Pick<Storage, "getItem">;
  calls: string[];
} {
  const calls: string[] = [];
  const storage: Pick<Storage, "getItem"> = {
    getItem(key: string) {
      calls.push(key);
      if (behavior.throwOnGet) {
        throw new Error("storage unavailable");
      }
      return behavior.value ?? null;
    },
  };
  return { storage, calls };
}

describe("readVivaEffectsPreference", () => {
  test("returns reduced for the exact stored value", () => {
    const { storage } = fakeStorage({ value: "reduced" });
    expect(readVivaEffectsPreference(storage)).toBe("reduced");
  });

  test("reads only the locked storage key", () => {
    const { storage, calls } = fakeStorage({ value: "reduced" });
    readVivaEffectsPreference(storage);
    expect(calls).toEqual([VIVA_EFFECTS_PREFERENCE_STORAGE_KEY]);
  });

  test("returns null when the key is missing", () => {
    const { storage } = fakeStorage({ value: null });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("returns null for an unknown stored string instead of treating it as reduced", () => {
    const { storage } = fakeStorage({ value: "true" });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("is case-sensitive and rejects a differently-cased value", () => {
    const { storage } = fakeStorage({ value: "REDUCED" });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("returns null for an empty stored value", () => {
    const { storage } = fakeStorage({ value: "" });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });

  test("fails closed to null instead of letting a throwing storage escape", () => {
    const { storage } = fakeStorage({ throwOnGet: true });
    expect(readVivaEffectsPreference(storage)).toBe(null);
  });
});

describe("viva effects shared constants", () => {
  test("locks the storage key and change-event names", () => {
    expect(VIVA_EFFECTS_PREFERENCE_STORAGE_KEY).toBe("viva.effects.preference.v1");
    expect(VIVA_EFFECTS_CHANGE_EVENT).toBe("viva-effects-change");
  });
});
