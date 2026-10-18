<div align="center">

<h1>ECHO</h1>

<h3>A little companion for your biggest questions.</h3>

<p>
A desktop learning companion that sees your screen, listens, talks back,<br>
and draws the explanation on a shared whiteboard.
</p><div align="center">

<h1>Echo</h1>

<h3>A little companion for your biggest questions.</h3>

<p>
A desktop learning companion that sees your screen, listens, talks back,<br>
and draws the explanation on a shared whiteboard.
</p>

<p><strong>Hacktoberfest 2026 · Built by lime</strong></p>

<p>
<a href="#download">Download</a> &nbsp;·&nbsp;
<a href="#features">Features</a> &nbsp;·&nbsp;
<a href="#how-it-works">How it works</a> &nbsp;·&nbsp;
<a href="#privacy-and-control">Privacy</a>
</p>

<br>

<img alt="Electron" src="https://img.shields.io/badge/Electron-111111?style=flat-square&logo=electron&logoColor=white">
<img alt="React" src="https://img.shields.io/badge/React-111111?style=flat-square&logo=react&logoColor=white">
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-111111?style=flat-square&logo=typescript&logoColor=white">
<img alt="Claude" src="https://img.shields.io/badge/Claude-111111?style=flat-square">
<img alt="Deepgram" src="https://img.shields.io/badge/Deepgram-111111?style=flat-square">

</div>

<br>

---

## Meet Echo

Echo lives on your desktop and helps you learn while you work. Share your screen, press `?`, and ask a question out loud. Echo looks at what you’re looking at, answers in a natural voice, and draws the explanation as it speaks.

Built for the moments when you’re stuck on code, an error message, a diagram, an equation, or a PDF—and want a patient tutor beside you.

<br>

## Download

**Download. Unzip. Install. Meet Echo.**

<<<<<<< HEAD
| Platform | Download | Installation |
|:---|:---|:---|
| **Windows** | [Download for Windows](WINDOWS_ZIP_URL) | Extract the ZIP and run the `.exe` installer |
| **macOS** | [Download for macOS](MACOS_ZIP_URL) | Extract the ZIP, open the `.dmg`, and drag Echo into Applications |
=======
| Platform | Installation |
|:---|:---|:---|
| **Windows** | [Download for Windows](https://github.com/unseenmeli/ECHO/releases/download/InstallersWIN/Echo.Setup.0.1.0.exe) | Run the `.exe` installer |
| **macOS (Apple Silicon)** | [Download for macOS](https://github.com/unseenmeli/ECHO/releases/download/Installers/Echo-0.1.0-arm64.dmg) | Open the `.dmg` and drag Echo into Applications |
>>>>>>> origin/main

Open Echo and follow the permission prompts for the features you want to use.

> No API keys or developer setup required. An internet connection is needed. Hosted demo access is subject to availability and usage limits.

<br>

## Features

<table>
<tr>
<td width="50%" valign="top">

<h3>Talk naturally</h3>
<p>Speak, ask follow-up questions, and interrupt whenever you need. Deepgram Flux handles turn detection, while Aura-2 speaks replies as Claude generates them.</p>

</td>
<td width="50%" valign="top">

<h3>Learn visually</h3>
<p>Diagrams, notes, tables, timelines, and charts take shape on a shared Excalidraw whiteboard as Echo explains. Your own drawings stay untouched.</p>

</td>
</tr>
<tr>
<td width="50%" valign="top">

<h3>Bring your context</h3>
<p>Share your screen or add notes and PDFs. Echo uses the relevant material, so you spend less time copying and explaining what you’re working on.</p>

</td>
<td width="50%" valign="top">

<h3>Make it yours</h3>
<p>Customize explanation depth, pace, humor, personality, voice, and language. Echo remembers how you prefer to learn.</p>

</td>
</tr>
</table>

| Capability | What it brings |
|:---|:---|
| **Deep dives** | Mechanisms, worked examples, misconceptions, and trade-offs |
| **Knowledge checks** | One question at a time, adaptive follow-ups, and what to review |
| **Runnable examples** | Python execution inside the lesson window with Pyodide |
| **Real pictures** | Wikimedia Commons images with author and license attribution |
| **Web research** | Search for current information and read relevant pages |
| **Model routing** | Fast replies for simple questions; stronger models for demanding explanations |
| **Editable drafts** | Prepare emails and posts for Gmail, Mail, X, or LinkedIn—you review and send |

<br>

## Your first lesson

1. **Open Echo.** Your companion appears on the desktop.
2. **Press `?` and ask a question.** Share your screen if you want help with something you’re viewing.
3. **Explore the explanation.** Open the whiteboard for a visual lesson.
4. **Make it a conversation.** Say “wait,” “give me an example,” or “explain that more simply.”

<br>

## How it works

| Step | What happens |
|:---|:---|
| **01 · Listen** | Audio streams to Deepgram Flux for transcription and turn detection. Local voice activity detection handles interruptions. |
| **02 · Look** | Your selected screen is captured as visual context. |
| **03 · Route** | Echo selects the model and reasoning configuration for your question. |
| **04 · Teach** | One tutor generates the spoken explanation and visual instructions together. |
| **05 · Draw** | A controller validates drawings and coordinates them with speech playback. |

<br>

## Privacy and control

| | |
|:---|:---|
| **Your screen, your choice** | Echo uses only the screen you select to share |
| **User-activated voice** | Press `?` to activate the microphone session |
| **Cloud processing** | Relevant audio, text, and shared screen captures are sent to configured providers |
| **Personal preferences** | Saved preferences help Echo adapt to how you like to learn |
| **You press send** | Echo prepares drafts but never sends emails or posts automatically |
| **Image retrieval** | Only search keywords are sent to Wikimedia for picture searches |

<br>

## Built with

| Layer | Technologies |
|:---|:---|
| **Desktop & interface** | Electron · React 19 · TypeScript · Vite |
| **Intelligence & voice** | Anthropic Claude · Deepgram Flux · Deepgram Aura-2 · Silero VAD |
| **Learning tools** | Excalidraw · Pyodide · pdf.js |
| **Infrastructure & testing** | Vercel · Upstash Redis · Zod · Vitest |

<br>

## Contributing

Contributions are welcome, especially during Hacktoberfest 2026.

Fork the repository, make a focused change, and open a pull request explaining what changed and why.

**Good places to start:** teaching instruction packs, whiteboard operations, translations, accessibility, and tests.

## License

License details to be added.

---

<div align="center">

<strong>Built by lime for Hacktoberfest 2026.</strong>

<p>
Pictures sourced from Wikimedia Commons.<br>
Author and license attribution included in the app.
</p>

</div>

<p><strong>Hacktoberfest 2026 · Built by lime</strong></p>

<p>
<a href="#download">Download</a> &nbsp;·&nbsp;
<a href="#getting-started">Getting started</a> &nbsp;·&nbsp;
<a href="#features">Features</a> &nbsp;·&nbsp;
<a href="#contributing">Contributing</a>
</p>

<br>

<img alt="Electron" src="https://img.shields.io/badge/Electron-111111?style=flat-square&logo=electron&logoColor=white">
<img alt="React" src="https://img.shields.io/badge/React-111111?style=flat-square&logo=react&logoColor=white">
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-111111?style=flat-square&logo=typescript&logoColor=white">
<img alt="Claude" src="https://img.shields.io/badge/Claude-111111?style=flat-square">
<img alt="Deepgram" src="https://img.shields.io/badge/Deepgram-111111?style=flat-square">

</div>

<br>

---

## Meet Echo

Echo lives on your desktop and helps you learn while you work. Share your screen, press `?`, and ask a question out loud. Echo looks at what you’re looking at, answers in a natural voice, and draws the explanation as it speaks.

Built for the moments when you’re stuck on code, an error message, a diagram, an equation, or a PDF—and want a patient tutor beside you.

<br>

## Features

<table>
<tr>
<td width="50%" valign="top">

<h3>Talk naturally</h3>
<p>Speak, ask follow-up questions, and interrupt whenever you need. Deepgram Flux handles turn detection, while Aura-2 speaks replies as Claude generates them.</p>

</td>
<td width="50%" valign="top">

<h3>Learn visually</h3>
<p>Diagrams, notes, tables, timelines, and charts take shape on a shared Excalidraw whiteboard as Echo explains. Your own drawings stay untouched.</p>

</td>
</tr>
<tr>
<td width="50%" valign="top">

<h3>Bring your context</h3>
<p>Share your screen or add notes and PDFs. Echo uses the relevant material, so you spend less time copying and explaining what you’re working on.</p>

</td>
<td width="50%" valign="top">

<h3>Make it yours</h3>
<p>Customize explanation depth, pace, humor, personality, voice, and language. Echo remembers how you prefer to learn.</p>

</td>
</tr>
</table>

| Capability | What it brings |
|:---|:---|
| **Deep dives** | Mechanisms, worked examples, misconceptions, and trade-offs |
| **Knowledge checks** | One question at a time, adaptive follow-ups, and what to review |
| **Runnable examples** | Python execution inside the lesson window with Pyodide |
| **Real pictures** | Wikimedia Commons images with author and license attribution |
| **Web research** | Search for current information and read relevant pages |
| **Model routing** | Fast replies for simple questions; stronger models for demanding explanations |
| **Editable drafts** | Prepare emails and posts for Gmail, Mail, X, or LinkedIn—you review and send |

<br>

## Download

| Platform | Installer |
|:---|:---|
| **Windows** | `.exe` — coming soon |
| **macOS** | `.dmg` — coming soon |

<br>

## Getting started

**Requirements:** Node.js 24+ and npm.

```bash
git clone <this-repo-url>
cd hackaton
npm install
cp .env.example .env
npm run dev
```

> Echo connects to its hosted backend by default. No API keys are needed to try it, subject to demo availability and usage limits.

<details>
<summary><strong>Use your own API keys</strong></summary>

<br>

Update `.env`:

```env
ECHO_BACKEND_URL=off
ANTHROPIC_API_KEY=your-anthropic-key
DEEPGRAM_API_KEY=your-deepgram-key
```

Keys are read by the Electron main process, never exposed to renderer windows, and never logged. Do not commit `.env`.

</details>

<br>

## How it works

| Step | What happens |
|:---|:---|
| **01 · Listen** | Audio streams to Deepgram Flux for transcription and turn detection. Local voice activity detection handles interruptions. |
| **02 · Look** | Your selected screen is captured as visual context. |
| **03 · Route** | A router selects the model and reasoning configuration for the request. |
| **04 · Teach** | One tutor generates narration and drawing instructions together through `<objective>`, `<draw>`, and `<say>` segments. |
| **05 · Draw** | A controller validates visual operations and coordinates them with sentence playback. |

Read the [visual lesson protocol](docs/visual-lessons.md) for implementation details.

<br>

## Development

<details>
<summary><strong>Scripts</strong></summary>

<br>

| Command | Description |
|:---|:---|
| `npm run dev` | Start development with hot reload |
| `npm run build` | Build the app |
| `npm start` | Preview the production build |
| `npm run typecheck` | Type-check the project |
| `npm test` | Run unit and integration tests |
| `npm run eval` | Run the model evaluation suite |
| `npm run dist:win` | Package the Windows installer |
| `npm run dist:mac` | Package the macOS installer |

</details>

<details>
<summary><strong>Configuration</strong></summary>

<br>

All available settings are documented in [`.env.example`](.env.example).

| Variable | Purpose |
|:---|:---|
| `ECHO_CLAUDE_MODEL` | Fast model for everyday replies |
| `ECHO_STRONG_MODEL` | Model for reasoning, screen analysis, and lessons |
| `ECHO_DEEP_MODEL` | Model for deep-dive lessons |
| `ECHO_QUALITY_ROUTES` | Turn types routed to the stronger model |
| `ECHO_STT_MODEL` | Speech recognition model |
| `ECHO_TTS_VOICE` | Aura-2 voice, such as `aura-2-jupiter-en` |
| `ECHO_WEB_SEARCH` / `ECHO_WEB_FETCH` | Web search and page reading |
| `ECHO_VISUALS` / `ECHO_PICTURES` | Whiteboard drawing and real pictures |
| `ECHO_COMPOSE_DESTINATIONS` | Allowed draft destinations, or `none` |

</details>

<details>
<summary><strong>Project structure</strong></summary>

<br>

| Path | Contents |
|:---|:---|
| `src/main/` | Voice, lessons, memory, study material, and tray |
| `src/preload/` | Restricted bridges between main process and windows |
| `src/renderer/` | Companion, voice dock, lessons, drafts, and preferences |
| `src/shared/` | Shared types and schemas |
| `skills/` | Visual teaching, deep explanation, and knowledge-check instructions |
| `backend/` | Anthropic proxy and temporary Deepgram tokens |
| `docs/` | Design notes and protocol documentation |
| `tests/` | Unit, integration, end-to-end, and live tests |
| `build/` | App icons and macOS entitlements |
| `scripts/` | Development tooling |

</details>

<details>
<summary><strong>Backend deployment</strong></summary>

<br>

The [`backend/`](backend/) directory is a separate Vercel project. It lets Echo run without bundling provider keys in the desktop app.

- Proxies Claude requests and issues short-lived Deepgram tokens.
- Controls access through access codes.
- Enforces per-code and global rate limits with Upstash Redis.
- Provides `GET /api/health` and `GET /api/usage`.

Generate access codes from the backend project:

```bash
npm run codes -- 5
```

Configure the secrets listed in [`backend/.env.example`](backend/.env.example) in your Vercel project settings, then deploy.

</details>

<br>

## Privacy and control

| | |
|:---|:---|
| **Your screen, your choice** | Echo uses only the screen you select to share |
| **User-activated voice** | Press `?` to activate the microphone session |
| **Cloud processing** | Relevant audio, text, and shared screen captures are sent to configured providers |
| **Protected credentials** | Provider keys stay out of renderer windows |
| **You press send** | Echo prepares drafts but never sends emails or posts automatically |
| **Image retrieval** | Only search keywords are sent to Wikimedia for picture searches |

<br>

## Tech stack

**Desktop**  
Electron · React 19 · TypeScript · Vite / electron-vite

**Intelligence & voice**  
Anthropic Claude · Deepgram Flux · Deepgram Aura-2 · Silero VAD

**Learning tools**  
Excalidraw · Pyodide · pdf.js

**Infrastructure & testing**  
Vercel · Upstash Redis · Zod · Vitest

<br>

## Contributing

Contributions are welcome, especially during Hacktoberfest 2026.

1. Fork the repository and create a branch.
2. Make a focused change.
3. Run `npm run typecheck` and `npm test`.
4. Open a pull request explaining what changed and why.

**Good places to start:** instruction packs, whiteboard operations, compose destinations, translations, accessibility, and tests.

## License

License details to be added.

---

<div align="center">

<strong>Built by lime for Hacktoberfest 2026.</strong>

<p>
Pictures sourced from Wikimedia Commons.<br>
Author and license attribution included in the app.
</p>

</div>
