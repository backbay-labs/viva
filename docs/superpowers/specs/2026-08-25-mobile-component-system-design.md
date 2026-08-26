# Viva Mobile — The Impression Component System

**Date:** 2026-08-25
**Status:** Treatment, depth semantics and grouping locked by owner. Type and global accent open.
**Companion:** `docs/superpowers/specs/2026-08-25-mobile-atmosphere-design.md` (the ground this sits on)
**Prototypes of record:** `.superpowers/brainstorm/50528-1787697798/content/{system,grouping}.html`

## 1. Why this exists

`apps/mobile` has a half-system. `ActionButton` (4 tones) and `VivaText` (6 variants × 5 tones) are
properly factored. **Surfaces are not:** `backgroundColor: colors.sheet + radius.md + borderWidth: 1`
is hand-written seven times across the four screens, and the only `TextInput` in the app is inline at
`session.tsx:653`. There is no `Card`, `Chip`, `Field`, `ListRow` or `Divider`.

So this is not a restyle. It is the first time surfaces get a system — which made it the right moment
to decide what they are made of, now that they sit on a living vellum ground.

## 2. The law

Six treatments were built and shown on the ground (glass, letterpress, tipped-in, ink & rule, vitrine,
illuminated). The owner's keeps and cuts across two rounds isolate a single rule:

> **The page is one plane. Nothing floats above it.**

Cut *into* it, ink *onto* it, or sit flush *with* it. Never stack on it. Tipped-in paper and
illuminated ornament were rejected precisely because they become separate objects casting shadows onto
the vellum; glass, letterpress, ink-and-rule and vitrine all survived because none of them do.

## 3. The treatment — LOCKED

Surfaces are **rounded-rect signed-distance fields cut into the vellum's height map**, from which the
shader derives a surface normal and lights them with the page's own sun.

| Uniform | Value |
| --- | --- |
| `bite` | **0.10** |
| `edge` | **0.65** |
| `ao` | **0.48** |
| `keyline` | **0.30** |
| `radius` | **7** |

**Read the numbers before implementing them.** Bite is near zero while occlusion is high: these are
not dents, they are **wells** — no real displacement, a crisp brass-edged boundary, a whisper of
neutral shadow pooling inside. That is what reconciles all four surviving treatments; it is mostly
vitrine's keyline-and-air with just enough press to be physical.

Two corrections from the failed first attempt, both worth not repeating:

- **No interior tint.** A real impression has no fill; the paper inside the well is the same vellum,
  only shaded. The original CSS version washed the interior `rgba(86,62,98,.055)`, which read as a
  cold grey box rather than a dent. Occlusion is the only tint, and it is neutral.
- **The light must be the page's light.** A CSS inset shadow is lit from nowhere and cannot agree with
  a drifting, tilting sun. Two light sources in one picture is the whole reason the first letterpress
  attempt felt wrong.

## 4. Depth is the state language — LOCKED

Four legible depths, carrying meaning rather than decoration:

| Depth | Meaning |
| --- | --- |
| `flush` | inert surface |
| `pressed` | interactive, at rest |
| `deeper` | being pressed right now |
| `raised` | selected, primary, or vital |

Consequences that fall out for free:

- A segmented control is **piano keys** — selected stands proud, the rest are held down. No colour.
- A switch is a **raised knob in a pressed channel**.
- The mastery gauge is a **channel cut in the page with ink lying in it**.
- Disclosure does not stack a panel; **the same well gets deeper**.
- On the correction screen the **repair is the one element that stands proud** — the only thing the
  student must not miss.
- **Press deepens the well** (spring, λ≈14). Not an added affordance; it is what pressing a surface does.

**Depth alternates with nesting level.** page → container *pressed* → row *raised* → detail *pressed*.
Adjacent levels always point opposite ways, so edges can never compete, and it extends to any depth
without new decisions.

## 5. Grouping — LOCKED

Two rounds of container designs were rejected before the parts were separated into dials. The locked
configuration:

```
boundary well · wash 4 · margin num · rows dots · folio acc · accent copper
```

- **boundary `well`** — a shallow scored well, the only shader-drawn part of the group
- **wash `4`** — 4% accent tint inside the well; colour assists the grouping so depth need not nest
- **margin `num`** — hanging numerals in the margin
- **rows `dots`** — dot leaders carrying the eye to the folio
- **folio `acc`** — page/interval references in the accent
- **accent `copper`** (`#B06A3B`) — see §7

The numerals are not decoration. **They can be referenced inline from the correction text** — "the
gradient **stores** the energy.¹" — which turns grouping into a function instead of a container. That
is the property that made this direction win over five container designs.

### 5.1 One device or two

Tested against three content shapes simultaneously, and the differences appear only in the degenerate
cases: a perforated boundary stops reading as a slip past ~3 rows; margin numerals are absurd at one
row. The locked configuration survives 1, 2 and 6 rows.

**Open (O-6):** sources are 1–3 items, concepts-due are 5–10. If they want different devices, that is
a rule, not an inconsistency — but it must be decided deliberately.

## 6. What to build

Primitives, all consuming a shared surface-token layer:

`Surface` (the depth primitive every other one wraps) · `Card` · `Chip` · `Field` · `ListRow` ·
`Divider` · `Group` (§5)

Complex, already designed in the prototype: segmented control, switch, mastery gauge, progress dots,
status banner, empty state, skeleton, correction/marginalia block, disclosure, bottom sheet.

## 7. Open questions

- **O-7 — Type pairing.** Six pairings built (Cormorant/EB Garamond/Spectral/Newsreader/Fraunces/
  Crimson Pro). Undecided, and **cannot be settled at desktop preview scale** — Cormorant's thinness
  is a physical-screen question. Recommendation: keep Cormorant unless it fails on device; it carries
  brand identity and only serves display/lead/title, with Hanken already handling everything small.
  Newsreader is the upgrade if it does fail (Viva already uses an italic display face).
- **O-8 — Global accent.** The owner said "Prussian + indigo" on the accent board, then selected
  **copper** inside the grouping component. Both stand; they were different questions asked in
  different contexts. Unresolved: whether one accent is global, or brass stays structural (keylines,
  rules, the spark) with a second accent carrying semantics. The manuscript-correct answer is that
  brass is structure and a second colour is rubrication — reserved for correction and repair.
  **The Prussian preference was formed under uneven light** (it was the rightmost, dimmest, coolest
  cell) and should be re-confirmed before it is treated as decided.
- **O-9 — Rect budget.** Surfaces are measured rects passed as shader uniforms. 24 slots is roughly
  one screen. Needs a real per-screen count, and a policy for what happens when a long list exceeds it.
- **O-10 — Layout measurement cost.** Surfaces stop being styled RN Views; they require a measurement
  pass to hand rects to the shader. Cost unmeasured on device, and it interacts with scrolling.

## 8. Implementation notes earned the hard way

- **Every length in the shader is in dp, never a fraction of the viewport.** Edge softness, height
  amplitude and the normal's sample epsilon were all viewport-relative; moving from a 252 pt phone to
  a 1400 px board turned a 3 px die edge into a 17 px smear. Same parameters, different result. On
  device this would have made a phone and a tablet disagree and looked like a design failure rather
  than a units bug. They now route through a `uPx` (p-space per dp) uniform.
- **Comparison surfaces must be evenly lit.** A raking light across a wide board means the leftmost
  cell sits in bright warm light and the rightmost in cool shadow — so a type or colour comparison is
  invalid. The prototype has an `even` mode for this reason, and O-8 exists because of it.
- **The grain never animates and is sized in dp** (≈1.25 dp cells). Reseeding per frame is TV static.
- Chrome caps WebGL contexts at ~16. Irrelevant on device (Skia is one canvas) but it dictates that
  the atmosphere is **one root canvas**, not one per component.
