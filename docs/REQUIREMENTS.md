# Viva PR Doc

> **Status: product vision, not shipped behavior.** Everything below is the product intent this
> repository is built toward — the press release, the personas, the screens, the modes, the pricing
> hypotheses, and the P0/P1/P2 backlog. It is deliberately preserved unedited as the north star, and
> it is deliberately **not** a description of what runs today.
>
> For what actually ships, read [`docs/public-contract.json`](public-contract.json), which is
> generated from the code by `node scripts/public-contract.mjs --write` and gated by `--check`.
> Where this vision document and that contract disagree, the contract is the truth and this document
> is the plan.
>
> Three differences are worth naming up front, because they are the ones most likely to mislead:
>
> | This document envisions | The shipped contract today |
> | --- | --- |
> | Four study modes (Quiz Me, Teach Me, Mock Viva, Cram) | Exactly one mode, `quiz`. The other three named engines that were never built and the server now rejects them. |
> | PDF upload, slide upload, image OCR | Pasted text and UTF-8 text uploads. Any PDF shape is refused fail-closed with `unsupported_pdf`; there is no page-aware extraction and no OCR. |
> | A tool surface that includes marking mastery and scheduling review | Five proposable tools. Concept status and the next review date are derived from server state inside a persisted turn outcome, never proposed by a model. |

**Version:** 0.1
**Product:** Viva
**Category:** Voice-first AI study companion
**Positioning:** Study by talking, not rereading.
**Core promise:** Upload your notes. Take a 10-minute study call. Viva quizzes you until you actually know it.

---

## 1. Product summary

Viva is a voice-first AI study companion that turns a student’s own materials into live oral study sessions.

Students upload PDFs, lecture slides, notes, readings, or transcripts. Viva reads the materials, identifies testable concepts, and creates a personalized study context. Then, instead of asking the student to reread summaries or flip through flashcards, Viva starts a focused voice session: it asks questions out loud, listens to the student’s answer, evaluates understanding, gives hints, corrects misconceptions, cites the source material, and builds a mastery map over time.

Viva is not a document chatbot.
Viva is not a flashcard generator.
Viva is not a dashboard.

Viva is an oral exam room for the AI era.

---

## 2. Press release draft

### Viva launches the first voice-first AI study companion that helps students master material by talking through it

**Viva turns class notes, slides, and readings into live study conversations that quiz, correct, and coach students using their own materials.**

Today, Viva introduces a new way for students to study: by talking.

Instead of rereading notes, passively reviewing summaries, or scrolling through endless flashcards, students can upload their class materials and start a live voice study session. Viva asks questions, listens to answers, pushes for clearer explanations, gives hints when needed, and brings back weak concepts until they stick.

The product is built around a simple idea: students often think they know something because they recognize it on the page. Viva helps them find out whether they can actually explain it from memory.

A student preparing for a biology exam can upload lecture slides, a study guide, and textbook excerpts, then say:

> “Quiz me on cellular respiration for 10 minutes.”

Viva begins a focused recall session:

> “Close the notes. Explain the role of NADH in oxidative phosphorylation.”

As the student answers, Viva evaluates the response in real time. If the answer is partially correct, Viva pushes deeper:

> “Good start. You mentioned electron transport, but you skipped why NADH matters. Try again using the phrase ‘electron donor.’”

When Viva corrects the student, it grounds the feedback in the uploaded material:

> “Your professor defines this on Lecture 5, slide 18.”

After each session, Viva creates a simple recap: what the student knows, what is shaky, what needs to be reviewed tomorrow, and what session to do next.

“Most study tools help students make more materials,” said the Viva team. “Viva helps students retrieve, explain, and repair their understanding. It feels less like using software and more like having a patient tutor who will not let you fake knowing it.”

Viva is designed for college students, medical and nursing students, law students, certification candidates, and anyone preparing for exams that require real understanding rather than passive recognition.

The product starts with four simple modes:

**Quiz Me** for fast active recall.
**Teach Me** for conversational explanation.
**Mock Viva** for stricter oral exam practice.
**Cram** for high-yield review before an exam.

The interface is intentionally minimal. At the center is a voice orb that represents the study session. Around it, Viva generates only the cards and actions that matter in the moment: a weak concept, a source reference, a hint, a next drill, or tomorrow’s review.

Viva is available first as a private beta for students preparing for upcoming exams.

---

## 3. The big idea

### Students do not need more notes. They need better retrieval.

Most AI study products turn documents into more documents: summaries, flashcards, quizzes, study guides. These are useful, but they often keep students in passive review mode.

The moment of truth is different:

Can the student close the notes and explain the concept?

Viva is built around that moment.

The product’s core loop is:

1. **Upload materials**
2. **Viva extracts testable concepts**
3. **Student starts a voice session**
4. **Viva asks recall questions**
5. **Student answers out loud**
6. **Viva evaluates and corrects**
7. **Viva tracks mastery**
8. **Viva brings weak concepts back later**

The key behavioral shift:

> From “I reviewed it” to “I can explain it.”

---

## 4. Target customer

### Primary user

College students preparing for exams in concept-heavy courses.

Best early categories:

- Biology
- Psychology
- Chemistry
- History
- Political science
- Economics
- Nursing
- Pre-med
- Law
- Certification prep

### Early wedge

The strongest wedge is students who need to **explain concepts**, not just memorize isolated facts.

Viva is especially useful when the exam involves:

- Short answer questions
- Essay questions
- Oral exams
- Clinical reasoning
- Case-based reasoning
- Professor-style conceptual questions
- Dense lecture slides
- Lots of uploaded readings

### Initial persona

**Ananya, 20, sophomore biology major**

Ananya has a biology midterm on Friday. She has 3 lecture decks, a study guide, and messy notes. She feels like she understands the material when she rereads it, but freezes when asked to explain it.

She does not want to organize her materials.
She does not want to create flashcards.
She does not want a dashboard.
She wants someone to quiz her and tell her what she does not know.

Viva should let her upload everything and start studying within 60 seconds.

---

## 5. Product positioning

### One-liner

**Viva is a voice-first AI tutor that turns your notes into live recall sessions.**

### Homepage headline

**Talk your way to mastery.**

### Subheadline

Upload your notes, slides, and readings. Viva turns them into short voice study sessions that quiz you, correct you, and bring back weak concepts until they stick.

### Core message

**Study by talking, not rereading.**

### Alternative taglines

- Turn your notes into a study call.
- The AI tutor that will not let you fake knowing it.
- Close the notes. Explain it back.
- Your personal mock oral exam, whenever you need it.
- Learn it out loud.

### What Viva is

- Voice-first study companion
- Active recall tutor
- Oral exam simulator
- Study coach trained on your materials
- Mastery tracker
- Source-grounded correction system

### What Viva is not

- Generic document chatbot
- Flashcard app
- Note-taking app
- Course dashboard
- LMS
- Essay writer
- Homework answer machine
- Passive summary generator

---

## 6. Core product principles

### 1. One primary action at a time

At any moment, the student should know what to do next.

Examples:

- Upload notes
- Start recall drill
- Answer current question
- Try again
- Get hint
- Review weak concept
- Schedule tomorrow’s drill

Avoid multi-panel dashboards, dense menus, or competing CTAs.

---

### 2. Voice is the product

The voice session is not an add-on. It is the center of the experience.

The UI should support conversation, not compete with it.

The voice orb should clearly represent the state of the tutor:

- Ready
- Listening
- Thinking
- Responding
- Correcting
- Encouraging
- Mock exam mode
- Session complete

---

### 3. Generative UI, not static dashboard

Viva should generate the interface around the student’s current context.

Before a session, it may show:

- “Exam Friday: prioritize Lectures 4–6”
- “You missed cellular respiration twice”
- “Start 10-minute recall drill”

During a session, it may show:

- “Try again using an example”
- “Need a hint?”
- “Show source”
- “Mark as shaky”

After a session, it may show:

- “Review NADH tomorrow”
- “You improved on glycolysis”
- “Next session: Krebs cycle, 8 minutes”

The product should feel like it is alive and adapting.

---

### 4. Calm pressure

Viva should be supportive but rigorous.

It should not overpraise.
It should not shame.
It should not feel childish.

Good tone:

> “You’re close. Try again with the mechanism.”

Bad tone:

> “Amazing job, superstar! You crushed it!”

Viva is a patient tutor, not a cheerleading mascot.

---

### 5. Source-grounded trust

When Viva explains or corrects something, it should make clear where the correction came from.

Source references should be lightweight:

- “Lecture 5, slide 18”
- “Chapter 4, page 72”
- “Your study guide, section 2”
- “Professor’s note from uploaded doc”

The student should be able to tap the source when needed, but citations should not clutter the flow.

---

## 7. MVP scope

### MVP goal

Prove that students will repeatedly use voice recall sessions before an exam.

The MVP should answer one question:

> Will a student upload course materials and voluntarily use Viva for multiple study sessions before a real test?

### MVP user flow

1. Student creates a study set.
2. Student uploads materials.
3. Viva extracts key concepts.
4. Viva recommends a first session.
5. Student starts a voice recall drill.
6. Viva asks questions and listens.
7. Viva gives hints and corrections.
8. Viva ends with a recap.
9. Viva schedules weak concepts for review.
10. Student returns for another session.

### MVP should feel magical because of the call, not because of breadth.

Do not build a huge study platform. Build the best possible 10-minute AI study call.

---

## 8. Core screens

## 8.1 First-run / upload screen

### Goal

Make uploading materials feel effortless and immediate.

### User question

> “What are we studying?”

### Required elements

- Viva wordmark
- Short product explanation
- Upload area
- Paste text option
- Optional exam date input
- Optional course / study set name
- Generated preview after upload
- Primary CTA: “Start first recall drill”

### Example copy

**What are we studying?**

Drop in your notes, slides, readings, or study guide. Viva will turn them into a study conversation.

After upload:

**Biology Midterm**
3 documents uploaded
27 testable concepts found
Exam Friday

Recommended first session:
**10-minute recall drill on Lectures 4–5**

CTA:
**Start first recall drill**

### Requirements

- Support PDF upload.
- Support pasted text.
- Support multiple documents per study set.
- Show upload progress.
- Show processing state.
- Generate study set name if not provided.
- Extract topics and subtopics.
- Detect likely exam date if present in material or typed by user.
- Suggest first session.

### Non-goals for MVP

- Google Drive sync
- Canvas integration
- Notion integration
- Folder management
- Complex file tagging
- Collaborative study sets

---

## 8.2 Generative home screen

### Goal

Give the student one clear next action.

The home screen should not feel like a dashboard. It should feel like a study cockpit.

### Required elements

- Viva wordmark
- Minimal nav
  - Today
  - Library
  - Sessions

- Current study context pill
  - Example: “Biology Midterm · 3 docs · Exam Friday”

- Large central voice orb
- Headline
  - “Talk your way to mastery”

- One dominant CTA
  - “Start 10-minute recall drill”

- 2–4 generated context cards

### Example generated cards

**Weak concept**
Cellular respiration
You missed this twice.

**Next best session**
Lecture 5 recall drill
10 minutes.

**Exam focus**
Exam Friday
Prioritize Lectures 4–6.

**Review tomorrow**
NADH, Krebs cycle, oxidative phosphorylation
8 minutes.

### Requirements

- Home adapts based on:
  - uploaded materials
  - exam date
  - prior session history
  - weak concepts
  - time since last study
  - study mode preference

- Home should never show more than four generated cards.
- There should be one dominant CTA.
- Student can switch study set.
- Student can upload more materials.

---

## 8.3 Live voice session screen

### Goal

Create the feeling of a focused study call.

This is the most important screen in the product.

### Required elements

- Large central voice orb
- Timer
- Current question
- Listening / thinking / responding state
- Minimal transcript
- Contextual action cards
- End session button
- Source access when relevant

### Session states

#### Ready

Viva is ready to begin.

Copy:

> “Ready for a 10-minute recall drill?”

CTA:

> “Start session”

#### Listening

Student is answering.

UI:

- Orb pulses softly.
- Transcript may appear in small form.
- No distracting cards.

Copy:

> “Listening…”

#### Thinking

Viva is evaluating the answer.

UI:

- Orb shifts into thinking state.
- Minimal delay indicator.

Copy:

> “Checking your answer…”

#### Feedback

Viva gives correction, hint, or follow-up.

UI may generate:

- Try again
- Need a hint?
- Show source
- Mark as shaky
- Explain simpler
- Next question

#### Mock viva

Stricter mode.

UI should feel more restrained. Fewer hints. More pressure.

Copy:

> “Answer without hints. I’ll follow up.”

### Example session

Viva:

> “Explain the role of NADH in oxidative phosphorylation.”

Student:

> “It helps make ATP by giving energy to the mitochondria.”

Viva:

> “Good start, but be more precise. NADH donates electrons to the electron transport chain. That electron flow helps build the proton gradient that drives ATP synthase.”

Generated actions:

- Try again using “electron donor”
- Show source
- Mark as shaky
- Next question

### Requirements

- Voice input and output.
- Interruptions allowed.
- Viva can ask open-ended questions.
- Viva can evaluate spoken answers.
- Viva can provide hints.
- Viva can ask follow-up questions.
- Viva can mark concepts as strong, shaky, or missed.
- Viva can cite uploaded source material.
- Viva can end with recap.

### Non-goals for MVP

- Multi-person study calls
- Professor live monitoring
- Video
- Realtime whiteboarding
- Full note editor
- Full chat-first mode

---

## 8.4 Correction / source moment

### Goal

Make corrections feel helpful, trustworthy, and non-punitive.

### Example correction

Student:

> “I think aerobic respiration produces 36 ATP.”

Viva:

> “Almost. For this course, your professor uses 30–32 ATP depending on the shuttle system.”

UI should show:

- Correction
- Source chip
- Concept status
- Suggested next action

### UI example

**Almost. Refine this.**

For this course, use **30–32 ATP**, depending on the shuttle system.

Source: **Lecture 5 · Slide 12**

Concept status: **Shaky**

Next:

- Try again
- Explain with shuttle systems
- Review later

### Requirements

- Corrections must distinguish between:
  - wrong
  - partially correct
  - correct but incomplete
  - correct but imprecise
  - course-specific discrepancy

- Source should appear when possible.
- If source confidence is low, Viva should say so.
- Student can tap to view source excerpt.
- Student can challenge correction.

### Important behavior

Viva should not pretend certainty when materials are ambiguous.

Example:

> “Your notes are inconsistent here. Lecture 5 says 30–32 ATP, while the textbook excerpt says 36–38. For your exam, I would prioritize the lecture slide.”

---

## 8.5 Session recap / mastery screen

### Goal

Turn a study session into clarity.

The recap should not feel like analytics. It should answer:

- What do I know?
- What am I shaky on?
- What should I do next?

### Required elements

- Warm summary headline
- Session duration
- Strong concepts
- Shaky concepts
- Missed concepts
- Source-linked moments
- Generated study plan
- One next action

### Example

**Good session, Ananya.**

You’re strong on photosynthesis basics, but oxidative phosphorylation needs another pass.

**Strong**
72% · 12 topics

**Shaky**
18% · 3 topics

**Review tomorrow**
10% · 2 topics

**Generated plan**

Today
Cellular respiration, Photosynthesis, Enzymes — completed

Tomorrow
Genetic code, Transcription — 15 min

May 16
Cell cycle, Mitosis — 15 min

CTA:

**Schedule tomorrow’s recall drill**

### Requirements

- Recap generated after every session.
- Concepts categorized as:
  - strong
  - shaky
  - missed
  - review later

- Recap should include next recommended session.
- Student can start another drill.
- Student can view source moments.
- Student can view transcript, but transcript is secondary.

---

## 8.6 Library / study sets screen

### Goal

Let students manage study contexts without feeling like a file manager.

### Required elements

Each study set card should show:

- Course / exam name
- Number of documents
- Exam date
- Last session
- Current mastery signal
- Next recommended drill

### Example card

**Biology Midterm**
3 documents · Exam Friday
Last session: 45 minutes ago
Next: Lecture 5 recall drill
Mastery: 64%

CTA:

**Resume studying**

### Requirements

- Show all study sets.
- Allow new study set creation.
- Allow adding documents to a study set.
- Allow archiving a study set.
- Allow deleting uploaded materials.
- Show document list only when user opens a study set.

### Non-goals

- Complex folders
- Tags
- Bulk file operations
- Classroom management
- Shared drives

---

## 8.7 Mobile companion screen

### Goal

Make Viva feel like a study call in your pocket.

Mobile should be more minimal than desktop.

### Required elements

- Study context
- Timer
- Voice orb
- Current question
- One or two contextual actions
- Hint button
- End session control
- Optional source button

### Mobile session example

Top:

**Biology Midterm**

Center:

06:48
Large voice orb
Listening…

Current question:

> Explain the role of NADH in oxidative phosphorylation.

Actions:

- Hint
- Show source

### Requirements

- One-handed use.
- Minimal reading.
- Large tap targets.
- Works for short sessions:
  - 5-minute quiz
  - 10-minute recall
  - cram mode

- The screen should collapse complexity while the student is speaking.
- Feedback cards appear only after the student answers.

---

## 9. Study modes

## 9.1 Quiz Me

Fast active recall.

### Behavior

- Viva asks concise questions.
- Student answers out loud.
- Viva gives brief feedback.
- Viva moves quickly.
- Good for repeated practice.

### Example

> “Define operant conditioning and give one example.”

---

## 9.2 Teach Me

Conversational learning mode.

### Behavior

- Viva explains concepts.
- Viva checks understanding after explanation.
- More supportive.
- More hints.
- Good for first exposure or confusion.

### Example

> “Let’s walk through oxidative phosphorylation. Then I’ll ask you to explain it back.”

---

## 9.3 Mock Viva

Strict oral exam mode.

### Behavior

- Less hand-holding.
- More follow-up questions.
- Fewer hints.
- More pressure.
- Good for oral exams, med/law, finals, interviews.

### Example

> “No hints for this round. Explain the mechanism, then defend your answer.”

---

## 9.4 Cram

High-yield exam prep.

### Behavior

- Prioritizes weak concepts.
- Prioritizes likely testable material.
- Uses exam date.
- Faster pacing.
- Generates short sessions.

### Example

> “You have two days. We’re focusing only on weak and high-yield concepts.”

---

## 10. Generative UI model

### Before a session

Viva generates:

- recommended session
- weak concepts
- exam-priority cards
- study plan
- source-based context
- estimated session length

Example:

> “Exam Friday. You’re shaky on cellular respiration. Start with a 10-minute recall drill.”

### During listening

Viva hides complexity.

Visible:

- timer
- orb
- current question
- listening state

No unnecessary cards.

### After answer

Viva generates context-specific actions:

- Try again
- Need a hint?
- Show source
- Explain simpler
- Mark as shaky
- Next question
- Slow down
- Go deeper
- Use an example

### After correction

Viva generates:

- source chip
- concept status
- retry prompt
- simpler explanation
- related question

### After session

Viva generates:

- recap
- mastery changes
- tomorrow’s review
- next recommended drill
- source-linked moments

---

## 11. AI behavior requirements

## 11.1 Document ingestion

Viva must be able to:

- parse uploaded documents
- identify title, author, course, topic if present
- chunk material into concepts
- extract definitions, examples, formulas, diagrams when possible
- identify likely testable concepts
- preserve source references
- handle overlapping or conflicting sources

### Output

For each study set, Viva should create:

- document index
- concept map
- source map
- possible question bank
- initial mastery baseline
- recommended first session

---

## 11.2 Question generation

Questions should be generated from uploaded materials.

Question types:

- definition
- compare / contrast
- mechanism
- cause and effect
- example generation
- application
- sequence / process
- professor-style conceptual
- short answer
- oral exam follow-up

Good questions:

> “Compare classical and operant conditioning using one example of each.”

Bad questions:

> “What is classical conditioning?”

Good questions force explanation.

---

## 11.3 Answer evaluation

Viva should evaluate:

- correctness
- completeness
- precision
- confidence
- use of key terms
- conceptual understanding
- misconceptions
- source alignment
- course-specific expectations

Viva should classify answers as:

- strong
- mostly correct
- partially correct
- vague
- wrong
- off-topic
- insufficient evidence

### Example evaluation

Student:

> “NADH gives energy to ATP.”

Evaluation:

- partially correct
- missing electron transport chain
- missing proton gradient
- imprecise language
- should ask student to retry using “electron donor”

---

## 11.4 Feedback generation

Feedback should be:

- concise
- specific
- supportive
- rigorous
- source-grounded when possible

Good feedback:

> “Good start. You named ATP, but the mechanism is missing. NADH donates electrons to the electron transport chain, which helps create the proton gradient that drives ATP synthase.”

Bad feedback:

> “Correct! NADH is important for ATP.”

---

## 11.5 Memory and spaced review

Viva should remember:

- concepts missed
- concepts answered strongly
- concepts marked shaky
- repeated mistakes
- preferred study mode
- exam date
- session history
- source references
- student confidence patterns

Viva should bring weak concepts back over time.

### Review logic

A concept should be reviewed sooner when:

- student missed it
- answer was vague
- student asked for hint
- exam date is near
- concept is central to many others
- concept has been missed repeatedly

A concept can be reviewed later when:

- student explained it clearly
- student answered follow-up questions
- concept has been strong across sessions
- exam is not imminent

---

## 12. Component system

### 12.1 Voice orb

The emotional center of Viva.

States:

- Idle
- Ready
- Listening
- Thinking
- Speaking
- Correcting
- Encouraging
- Mock viva
- Session complete

The orb should feel alive but restrained. No gimmicky animations.

---

### 12.2 Context pill

Shows current study context.

Examples:

- Biology Midterm · 3 docs · Exam Friday
- Psych 201 · 5 docs · Final May 22
- Organic Chemistry · Chapter 7 · Quiz tomorrow

---

### 12.3 Generated action card

A contextual next action generated by Viva.

Examples:

- Try again using an example
- Need a hint?
- Show source
- Review tomorrow
- Start 5-minute drill
- Explain simpler
- Go deeper

---

### 12.4 Study mode chip

Lightweight mode selector.

Modes:

- Quiz Me
- Teach Me
- Mock Viva
- Cram

---

### 12.5 Source chip

Small, trust-building reference.

Examples:

- Lecture 5 · Slide 18
- Chapter 4 · Page 72
- Study Guide · Section 2
- Notes · Photosynthesis

---

### 12.6 Mastery topic chip

Shows status of a concept.

Examples:

- Strong
- Shaky
- Missed
- Review tomorrow
- Improving

---

### 12.7 Session recap card

Summarizes one study session.

Includes:

- duration
- concepts practiced
- strong concepts
- weak concepts
- next recommendation

---

### 12.8 Weak concept card

Shows a concept Viva wants to revisit.

Example:

**Cellular respiration**
Missed twice
Review in next drill

---

### 12.9 Timeline item

Used in generated study plan.

Example:

Tomorrow
Genetic code, transcription
15 min

---

## 13. Tone and copy

### Viva voice

Viva should sound:

- warm
- intelligent
- concise
- rigorous
- calm
- slightly challenging

### Good copy examples

- “Close the notes. Explain it back.”
- “You’re close. Try again with an example.”
- “Good start, but you skipped the mechanism.”
- “This came from Lecture 5.”
- “Let’s bring this back tomorrow.”
- “You do not need more notes. You need retrieval.”
- “Try again, but use the phrase ‘proton gradient.’”
- “I’ll give you a hint, not the answer.”
- “That was correct, but too vague for an exam.”
- “Let’s make it sharper.”

### Avoid

- “Awesome job superstar!”
- “Unlock your learning journey.”
- “AI-powered productivity dashboard.”
- “Gamify your study workflow.”
- “Crush your goals.”
- “Let’s make studying fun!”
- “Here are 17 widgets.”

---

## 14. Functional requirements

### P0: Required for MVP

- Create account
- Create study set
- Upload PDF
- Paste notes
- Process documents
- Extract concepts
- Generate first study session
- Voice input
- Voice output
- Live session timer
- Ask oral questions
- Evaluate spoken answers
- Give feedback
- Generate hints
- Ask follow-up questions
- Cite source material
- Mark concepts strong/shaky/missed
- Generate session recap
- Recommend next session
- Basic study set library

### P1: Soon after MVP

- Slide upload
- DOCX upload
- Image OCR for slides/screenshots
- Calendar-style exam date planning
- Push notifications for review
- Spaced repetition scheduling
- Mobile app
- Source viewer
- Session transcript
- More study modes
- Professor-style question generation
- Shareable study set

### P2: Later

- Google Drive integration
- Canvas / LMS integration
- Tutor dashboards
- Course creator accounts
- Group study mode
- Professor-uploaded official study agents
- Multi-modal diagram questioning
- Whiteboard-style explanations
- Certification-specific templates
- Institutional accounts

---

## 15. Non-goals

Viva should not initially become:

- A full LMS
- A notes app
- A flashcard marketplace
- A social study network
- A generic ChatPDF clone
- A homework solver
- A paper-writing assistant
- A classroom management platform
- A full tutoring marketplace
- A giant analytics dashboard

The product should remain narrow:

> Upload notes. Talk. Get quizzed. Improve.

---

## 16. Success metrics

### Activation

- % of users who upload at least one document
- % of users who start first voice session
- Time from landing to first question answered
- % of uploaded study sets that produce a session

### Engagement

- Sessions per user per week
- Average session length
- Repeat sessions before exam
- % of users completing 3+ sessions
- % of users returning next day
- Number of concepts reviewed per session

### Learning behavior

- % of questions answered without hints
- Improvement on previously missed concepts
- Reduction in repeated mistakes
- Number of weak concepts converted to strong
- Follow-up question success rate

### Retention

- Day 1 retention
- Day 7 retention
- Return rate before next exam
- Study set reuse
- Session streaks, but do not over-gamify them

### Monetization

- Free-to-paid conversion
- Conversion after first recap
- Conversion after hitting voice minute limit
- Exam cram pass purchase rate
- Monthly subscription retention

### Qualitative

Ask users:

- “Did Viva reveal something you thought you knew but didn’t?”
- “Did you use Viva more than once before your exam?”
- “Would you rather use Viva than reread your notes?”
- “Did the corrections feel trustworthy?”
- “Did the voice experience feel natural?”

---

## 17. Pricing hypothesis

### B2C student pricing

Free tier:

- Limited document uploads
- Limited voice minutes
- Basic recap

Paid tier:

- $12–$19/month
- More voice minutes
- Unlimited or high-limit study sets
- Deeper mastery tracking
- Spaced review
- Cram mode

Exam cram pass:

- $5–$10
- One-week access before an exam
- Useful for students who do not want a subscription

### Tutor / course creator pricing

Later opportunity:

- $49–$199/month per tutor or creator
- Upload curriculum
- Give students access to a branded Viva tutor
- Track student weak areas
- Higher willingness to pay than individual students

---

## 18. Launch strategy

### Phase 1: Friend prototype

Build for one real student and one real exam.

Goal:

> Can the student upload materials and use Viva three times before the test?

Do not optimize for scale yet.

### Phase 2: Single-class beta

Recruit 5–20 students from the same class.

Benefits:

- Same materials
- Same exam date
- Same concepts
- Natural sharing
- Easier quality control

Goal:

> Does Viva become part of the actual exam-prep behavior?

### Phase 3: Campus ambassador / exam-week wedge

Position around exam crunch.

Messaging:

- “Got an exam this week?”
- “Upload your notes. Take a 10-minute recall drill.”
- “Find out what you actually know.”

### Phase 4: Tutor / creator pilot

Give a tutor or course creator the ability to upload their curriculum and create a Viva study agent for their students.

This may become the better business model long-term.

---

## 19. Risks

### Risk 1: The product becomes a generic document chatbot

Mitigation:

- Voice-first by default
- Oral recall as the central flow
- Minimal chat UI
- No giant document Q&A interface as the main product

### Risk 2: Students like the idea but do not use it repeatedly

Mitigation:

- Build for exam urgency
- Short sessions
- Push “next best drill”
- Make first session useful within 60 seconds
- Measure repeat usage before building more features

### Risk 3: Answer evaluation feels unreliable

Mitigation:

- Source-ground corrections
- Use humility when uncertain
- Let students view source
- Let students challenge feedback
- Prefer “partially correct” over binary grading

### Risk 4: Voice latency hurts the experience

Mitigation:

- Keep prompts concise
- Use clear listening/thinking states
- Allow interruption
- Use adaptive short feedback
- Avoid long lectures in voice mode

### Risk 5: UI becomes too beautiful but not useful

Mitigation:

- One primary action per screen
- Test with real study sessions
- Prioritize speed to first question
- Every card must answer “what should I do next?”

### Risk 6: Academic integrity concerns

Mitigation:

- Position as study and recall, not answer generation
- Avoid homework-solving flows
- Encourage explanation and understanding
- Do not optimize for completing assignments on behalf of students

---

## 20. Privacy and trust

Viva handles sensitive student materials. The product must be clear about:

- who can see uploaded documents
- whether documents train models
- how to delete materials
- how source references are stored
- how transcripts are stored
- whether voice recordings are saved
- how students can export or delete their data

Baseline trust requirements:

- Delete study set
- Delete uploaded document
- Delete session transcript
- Clear privacy language during upload
- No public sharing by default
- No professor or school visibility unless explicitly enabled

---

## 21. Open questions

### Product

- Should the first version be web-only, mobile-only, or responsive web?
- Should voice sessions require account creation before first use?
- Should users be able to try a demo without uploading documents?
- Should Viva support chat at all, or only voice plus generated cards?
- How strict should Mock Viva be?
- Should students be able to choose professor style?

### AI

- How should Viva handle conflicting source material?
- What confidence threshold is required for source-grounded correction?
- How should answer grading be calibrated across subjects?
- How much transcript should be shown during a session?
- Should Viva interrupt students when they are wrong, or wait until they finish?

### Business

- Is the better wedge B2C students or tutors/course creators?
- Is the strongest pricing model subscription or exam cram pass?
- Should the launch focus on one subject first?
- Can shared class materials create viral loops?

---

## 22. Product quality bar

Viva should feel like a premium consumer AI product.

A user should understand the product within three seconds:

1. Upload notes.
2. Talk with Viva.
3. Get quizzed.
4. Master weak concepts.

The UI should be sparse, calm, and alive. The product should not feel like software for managing studying. It should feel like entering a focused study ritual.

The ideal first-session reaction:

> “Oh. This is way better than rereading my notes.”

The ideal third-session reaction:

> “Viva knows exactly what I keep messing up.”

The ideal paid-conversion moment:

> “I have an exam Friday. I need this.”

---

## 23. MVP acceptance criteria

The MVP is successful when a student can:

1. Upload at least one course document.
2. Start a study session within 60 seconds of processing.
3. Answer spoken questions out loud.
4. Receive useful feedback on their answers.
5. See at least one correction grounded in source material.
6. Finish a session and understand what they know versus what they need to review.
7. Return for a recommended follow-up session.
8. Say that Viva helped them discover a gap they would not have noticed by rereading.

---

## 24. Final product direction

Viva should own one clear behavior:

> **Oral active recall from your own materials.**

Everything else should support that.

Do not compete on having the most features.
Do not compete on the biggest dashboard.
Do not compete on generic AI study tools.

Compete on making the student feel, within one study call:

> “This thing actually knows what I understand.”
