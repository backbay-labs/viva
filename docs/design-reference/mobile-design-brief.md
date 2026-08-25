# Viva mobile design brief

## Feature summary

Viva mobile is a voice-first oral-exam room for students preparing for concept-heavy exams. It
must let a student move from exam context to active recall in one tap, keep the spoken question
primary during a session, ground every correction in the student's sources, and close with one
clear next review action.

## Primary user action

Begin or resume the highest-value recall session without organizing materials or interpreting a
dashboard.

## Design direction

The mobile expression is **the pocket folio**: a living academic manuscript rendered on warm
vellum, with aubergine ink, museum-label metadata, and a single luminous voice orb. The orb is the
memorable object, but it never outranks the question. The app feels scholarly, composed, and
exacting—never like a chat client, flashcard deck, generic AI assistant, or analytics dashboard.

## Layout strategy

- Home is an asymmetric editorial page: study-set context, direct greeting, orb, one weak concept,
  and a full-width recall action in the lower thumb zone.
- A live session collapses to elapsed time, voice state, orb, waveform, question, and two secondary
  escape hatches: hint and typed answer.
- Correction reads as marginalia: learner answer, precise repair, bounded citation, and “Try again.”
- Recap is a ledger rather than a chart wall: strong, shaky, tomorrow, moments worth revisiting,
  and the next scheduled drill.
- Content is capped on tablet and web previews while remaining edge-aware on small phones.

## Key states

- First run / empty library: explain what to add and why, then open the native document picker.
- Ready: disclose microphone behavior before requesting permission.
- Requesting microphone: preserve context and name the system action.
- Listening: collapse visual chrome and provide a visible “Finish answer” control.
- Thinking: keep the question visible while the local prototype evaluates.
- Correction: distinguish the learner's answer, the repair, and its source.
- Microphone unavailable: keep the session usable with typed input and explicit recovery copy.
- Recap: make the next review action dominant without inflated praise.
- Loading and reduced motion: preserve meaning without spatial animation.

## Interaction model

Tap “Begin recall” to enter a ready session. Microphone permission is requested only after “Start
listening.” The scaffold records locally, stops on “Finish answer,” and moves through a synthetic
evaluation state to source-grounded correction. Typed answer follows the same state machine.
Inline hints and sources use progressive disclosure rather than modal interruption. Haptic feedback
marks meaningful transitions. Session exit and recap use normal stack navigation and platform back
gestures.

## Content requirements

Use realistic biology material already established in Viva's design references. Recovery copy must
say what happened and what the learner can do next. Privacy copy must not imply background capture
or upload. Source labels must name the document and slide or page.

## Recommended implementation references

- `spatial-design.md` for the single-column rhythm and thumb-zone controls.
- `typography.md` for the Cormorant / Hanken Grotesk hierarchy.
- `interaction-design.md` for permission, loading, focus, and fallback states.
- `motion-design.md` for the orb and reduced-motion behavior.
- `adapt/SKILL.md` for phone, tablet, orientation, and touch adaptation.

## Open questions

- Bind the recording seam to the existing 24 kHz PCM WebSocket protocol after the visual scaffold.
- Decide whether the first production release uses Expo development builds or waits for Expo Go to
  match SDK 57.
- Replace synthetic study-set and recap data only through server-authoritative session projections.

## Generated exploration

- `generated-mobile/home-session.png`
- `generated-mobile/correction-recap.png`
