# Visual lessons

When the lesson window is open, ECHO explains aloud while drawing on the shared Excalidraw board. There is one agent: the tutor (same `ANTHROPIC_API_KEY` and `ECHO_CLAUDE_MODEL`) writes each step's drawing and narration together, so the lesson runs at the tutor's own pace.

**Segment format** (`lesson/tutorProtocol.ts`): `<objective>`, optional `<data>` (numbers for charts), optional `<draw>` (JSON: `setup` ops drawn before the narration, `cues` applied when a sentence is reached), then `<say>`. A segment is handed over the moment `</say>` arrives, so speech starts as early as possible.

**Controller** (`lesson/controller.ts`) owns timing: it checks the drawing against the live board (`lesson/validate.ts`; invalid cues are dropped, an invalid drawing means a verbal-only segment and a quiet status), draws the setup, sends the narration to TTS sentence by sentence, and fires each cue when the audio engine reports that sentence's audio actually started.

**Ops, not Excalidraw JSON**: `lesson/ops.ts` (zod) defines the operations; `lesson/translate.ts` lays them out and styles them. AI elements are tagged `customData.echo`; the user's own drawings are never modified or removed. Charts can only plot a `<data>` block the tutor supplied.

**Sync precision**: Deepgram streaming TTS exposes no word timestamps, so cues are sentence level (one TTS flush per sentence; flushes are rate limited so sentences can merge, which only makes a cue fire slightly early). Delay from audio start to cue applied is logged as `[lesson] metrics`.

**Tests**: `npm test`; `node tests/e2e/run.mjs <clip.wav> lesson lessonChart lessonInterrupt lessonReopen` (real Electron, stand-in servers; build first); `tests/e2e/live-lesson.mjs` (real services, plays audio).

**Instruction packs** (`skills/<name>/SKILL.md`, loaded by `src/main/skills`): teaching guidance added to the tutor's system prompt only for the turns it applies to. These are prompt text for the same single tutor model; they are not another agent and they do not train anything. `visual-teaching` is loaded for every whiteboard reply, `deep-explanation` when the learner asks for depth (the router says DEEP, or the go-deeper button), and `check-understanding` from an explicit practice or quiz request until the learner ends it (at most 12 turns). The files are bundled at build time, so choosing packs costs no disk I/O during a turn. The order in a request is the core prompt, then saved preferences and context, then the lesson protocol (format and hard limits only), then the packs, then the tool rules. The selection is logged as `[voice] skills: …`. `tests/skills.test.ts` checks that every example segment in a pack parses with the real protocol, and that the HTTP request Claude receives contains exactly the selected packs.
