# Visual lessons

When the lesson window is open, ECHO explains aloud while drawing on the shared Excalidraw board. There is one agent: the tutor (same `ANTHROPIC_API_KEY` and `ECHO_CLAUDE_MODEL`) writes each step's drawing and narration together, so the lesson runs at the tutor's own pace.

**Segment format** (`lesson/tutorProtocol.ts`): `<objective>`, optional `<data>` (numbers for charts), optional `<draw>` (JSON: `setup` ops drawn before the narration, `cues` applied when a sentence is reached), then `<say>`. A segment is handed over the moment `</say>` arrives, so speech starts as early as possible.

**Controller** (`lesson/controller.ts`) owns timing: it checks the drawing against the live board (`lesson/validate.ts`; invalid cues are dropped, an invalid drawing means a verbal-only segment and a quiet status), draws the setup, sends the narration to TTS sentence by sentence, and fires each cue when the audio engine reports that sentence's audio actually started.

**Ops, not Excalidraw JSON**: `lesson/ops.ts` (zod) defines the operations; `lesson/translate.ts` lays them out and styles them. AI elements are tagged `customData.echo`; the user's own drawings are never modified or removed. Charts can only plot a `<data>` block the tutor supplied.

**Sync precision**: Deepgram streaming TTS exposes no word timestamps, so cues are sentence level (one TTS flush per sentence; flushes are rate limited so sentences can merge, which only makes a cue fire slightly early). Delay from audio start to cue applied is logged as `[lesson] metrics`.

**Tests**: `npm test`; `node tests/e2e/run.mjs <clip.wav> lesson lessonChart lessonInterrupt lessonReopen` (real Electron, stand-in servers; build first); `tests/e2e/live-lesson.mjs` (real services, plays audio).
