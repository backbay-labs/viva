# Viva Mobile — The Impression Component System

**Date:** 2026-08-25
**Status:** Treatment, depth semantics and grouping locked. Build-readiness pass completed 2026-08-25 (§7–§16).
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
- **accent `copper`** (`#B06A3B`) — but see §7's accent roles and §15's O-8; the *text* value must be `copperInk` #693F23, not `copper` (atmosphere spec §11.2)

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

## 7. The surface token layer

Every primitive in §6 consumes these; nothing hard-codes a depth.

```ts
// depth — the state language of §4, in bite-multiplier units
depth = {
  flush:   0,      // inert
  chip:    0.7,    // small pressed
  card:    1.0,
  button:  1.0,
  input:   1.25,   // deepest at rest: a field should feel like a slot
  tray:    1.45,
  track:   1.6,
  gauge:   1.7,    // a channel, not a surface
  raised: -1.0,    // selected / primary / the repair
  pressDelta: 0.9, // added, sign-following, while held
}

keyline = { none: 0, normal: 1.0, strong: 2.2, accent: 2.6 }
radius  = { surface: 7, pill: 999 }   // 7 is locked; pill is the primary CTA only
```

**Accent roles** — this is where §15's O-8 gets resolved once, rather than per component:

| role | job | value |
| --- | --- | --- |
| structural | keylines, rules, hairlines, the spark | `gold` #BD9A55 |
| grouping | group labels, folios, leaders (§5) | `copperInk` #693F23 |
| rubrication | correction and repair only | *pending O-8* |

Ornament values and `*Ink` text values are distinct tokens, per atmosphere spec §11. **A component
never picks a hex; it picks a role.**

## 8. Motion

| event | change | timing |
| --- | --- | --- |
| press in | depth `+pressDelta` | spring λ≈14 (~180 ms to 95%) |
| press out | depth → rest | λ≈2.6 (~700 ms), deliberately slower than the attack |
| segmented select | old `pressed` → new `raised` | 220 ms, both simultaneously |
| switch | knob translate + track depth | 180 ms ease-out |
| disclosure open | same well, depth `1.0 → 1.35` + height | 240 ms |
| sheet present | second leaf slides up, page beneath dims 8% | 320 ms, existing `fade_from_bottom` curve |
| gauge fill | width | 600 ms ease-out, once, on data change only |
| skeleton | shimmer sweep | 1.6 s linear, static under reduce-motion |

Press-out is slower than press-in on purpose: a real impression relaxes, it does not snap.

## 9. The modal exception to the plane law

"Nothing floats above the page" is a rule about **chrome**, and a modal is not chrome — it is a
different page. The existing `fade_from_bottom` stack already replaces rather than hovers, so screens
need no exception.

The bottom sheet is the one hard case, and a floating panel would break the law outright.
**Resolution: the sheet is a second leaf of vellum slid over the first.** It carries its own ground
(same material, its own light sample) and the page beneath dims ~8%. Two leaves of the same substance,
never glass over paper. This also means the sheet's own surfaces nest correctly under §4's alternation
rule, because it starts a fresh depth level at the page plane.

## 10. Rects under scroll, and the budget

**Never re-measure per frame.** Measure on layout, keep rects in a Reanimated shared value, and
subtract the scroll offset inside `useAnimatedScrollHandler` before the uniforms are written — the
whole point of JS owning the light state is that scrolling costs a subtraction, not a layout pass.

Re-measure on exactly these: `onLayout`, font-scale change (§11), rotation, list data change, and
disclosure open/close.

**Budget policy (resolves O-9).** 24 uniform slots ≈ one screen. Only surfaces intersecting the
viewport (plus one screen of margin) occupy a slot; slots are recycled by index in scroll order. A
list long enough to exceed 24 visible surfaces must virtualize — which the four screens do not
currently do (`ScrollView`, 14 usages), so **`library.tsx` and `recap.tsx` need a slot audit before
Act 1 ships**. If a screen genuinely exceeds the budget, the overflow surfaces degrade to a hairline
border rather than disappearing.

## 11. Dynamic Type

`VivaText` already sets `maxFontSizeMultiplier` (1.45 display / 1.8 otherwise). Because surfaces are
measured, a font-scale change is a **layout event, not a style event** — it must trigger
re-measurement or the wells will sit behind text that has outgrown them. At 1.8× the two-column rows
in §5 (title + folio) will wrap; the folio moves below the title rather than compressing.

## 12. Haptics must agree with depth

`ActionButton` currently fires `Haptics.impactAsync` inside `onPress` — which is **release**. The
visual deepening happens at **press-in**. As written, the tap you feel and the dent you see are
different events, roughly 100–300 ms apart.

**Fix: move the haptic to `onPressIn`,** so the impact coincides with the well deepening. Keep the
existing tone mapping (Medium for primary, Light otherwise). This is a two-line change and it is the
difference between a system that feels physical and one that feels merely animated.

## 13. Icons are inked, not impressed

`SparkIcon` and `ArrowUpRightIcon` stay `react-native-svg` and are drawn *on* the page in ink or
accent. **An icon is a mark, not a surface** — impressing it would put it in the same category as a
container and dilute the state language, where depth means interactive. Marks have no depth.

## 14. Content edge cases

- A well **grows with its content and never scrolls internally.** Internal scroll would put a moving
  surface inside a fixed impression, which is incoherent.
- Long concept titles wrap to two lines maximum, then truncate with a tail ellipsis; the folio never
  truncates.
- Missing folio renders an em dash in the same slot, so the dot leader still terminates.
- Zero rows: the group renders its heading and an empty-state line *inside* the well — the well does
  not collapse, because a group that vanishes reads as a bug.
- The repair block has no length cap; it is the one element allowed to be as long as it needs.

## 15. Testing

- **Unit:** depth resolution per state (`selected`, `disabled`, `pressed`, `expanded`); the rect
  measurement → p-space transform; slot recycling; budget overflow degradation.
- **Golden frames:** each primitive at each state, at 1× and 1.8× font scale.
- **Accessibility assertions:** every depth-encoded state also sets the matching `accessibilityState`
  (atmosphere spec §12) — assertable in the existing `bun test` suite.
- **Contrast:** the atmosphere spec §11.3 table test covers the tokens these components consume.

## 16. Build readiness

**Decided and buildable now:** the treatment and its five parameters; the plane law; the depth state
language and its nesting alternation; the grouping configuration; the surface token layer (§7); motion
(§8); the sheet resolution (§9); scroll and budget policy (§10); haptics (§12); icons (§13).

**Blocking a first commit — small, and mine to do:**
- Apply the `*Ink` token split from atmosphere spec §11 to `theme/tokens.ts` and `packages/tokens`.
- Swap the locked `folio acc` to `copperInk` (§11.2 of the atmosphere spec).
- Move the haptic to `onPressIn`.

**Blocking, and needs the owner:**
- **O-7 type pairing** — cannot be judged off-device. Proposal: build Act 1 on Cormorant unchanged;
  the pairing is a token swap afterwards, so it is not on the critical path.
- **O-8 global accent** — needed before the correction screen, not before Act 1.
- **O-6 one grouping device or two** — needed before `library.tsx` and `recap.tsx`, not before home.

**Blocking, and needs a device:** the atmosphere spec's §14 acceptance criteria, and G-1 (the physical
iPhone gate carried over from Stage 0) — tilt is the largest aliveness lever and *cannot* be validated
in a simulator.

None of these block **Act 1** (surface, vignette, grain, on every screen), which is the point of the
staging: it can start immediately.

## 17. Open questions

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
- ~~**O-9 — Rect budget.**~~ **Resolved in §10.** Original note: surfaces are measured rects passed as shader uniforms. 24 slots is roughly
  one screen. Needs a real per-screen count, and a policy for what happens when a long list exceeds it.
- **O-10 — Layout measurement cost.** Surfaces stop being styled RN Views; they require a measurement
  pass to hand rects to the shader. Cost unmeasured on device, and it interacts with scrolling.

## 18. Implementation notes earned the hard way

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
