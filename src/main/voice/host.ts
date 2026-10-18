import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, session as electronSession, shell, systemPreferences } from 'electron'
import { board, isBoardOpen } from '../board'
import { CommonsPictures } from '../lesson/pictures'
import { ClaudeChat } from './claude'
import { loadEnvFiles, readVoiceConfig } from './config'
import { DeepgramTts } from './tts'
import { deepgramAuthFor } from './backend'
import { accessCodeFor, backendUrl, type AccessCodeStore } from '../accessCode'
import { FluxClient } from './flux'
import { screenVoiceContext } from './screenProvider'
import type { EnginePort } from './ports'
import { VoiceSession } from './session'
import { showDraft } from '../compose/draftWindow'
import { DeckStudio } from '../deck/deckTools'
import { closeDeck, isDeckOpen, printDeck, showDeck } from '../deck/deckWindow'
import { saveDeck } from '../deck/saveDeck'
import { withEchoPicture } from '../deck/echoPicture'
import { composeUrl, type Draft, type DraftEdits } from '../../shared/compose'
import type { PreferenceStore } from '../memory/preferenceStore'
import type { StudyMaterialPort } from '../study/studyMaterial'
import {
  IDLE_SNAPSHOT,
  isOpenableUrl,
  parseVoiceCommand,
  type EngineError,
  type EnginePlaybackReport,
  type VoiceCommand,
  type VoiceEvent,
  type VoiceSnapshot,
  type VoiceStateReply
} from '../../shared/voice'

const isDev = !app.isPackaged

/**
 * Wires the voice session to Electron: credentials, the hidden audio engine
 * window, microphone permission and the narrow IPC surface the UI windows use.
 * Credentials never leave this process.
 */
class VoiceHost {
  private session: VoiceSession | null = null
  private engine: BrowserWindow | null = null
  private configError: VoiceSnapshot | null = null
  private envLoaded = false
  private canCaptureScreen: (wc: Electron.WebContents) => boolean = () => false
  private openLesson: (timeoutMs: number) => Promise<boolean> = async () => false
  private closeLesson: () => void = () => {}
  private preferences: PreferenceStore | null = null
  private study: StudyMaterialPort | null = null
  private access: AccessCodeStore | null = null
  /** Kept across conversations, so a picture found once is not downloaded again. */
  private pictures: CommonsPictures | null = null
  /** The deck ECHO is working on, kept across conversations so "save it" works after a restart. */
  private readonly decks = this.createDeckStudio()

  // --- EnginePort ---------------------------------------------------------------------
  private readonly enginePort: EnginePort = {
    start: (muted, bargeInMs) => this.openEngine(muted, bargeInMs),
    stop: () => this.closeEngine(),
    setMuted: (muted) => this.toEngine('voice-engine:mute', muted),
    sendAudio: (id, pcm) => this.toEngine('voice-engine:audio', id, pcm),
    segmentMarker: (id, segment) => this.toEngine('voice-engine:marker', id, segment),
    responseDone: (id) => this.toEngine('voice-engine:done', id),
    clearPlayback: (id) => this.toEngine('voice-engine:clear', id),
    duck: (on) => this.toEngine('voice-engine:duck', on)
  }

  /**
   * @param canCaptureScreen The window allowed to share the screen (the companion).
   * @param openLesson Opens the lesson window and resolves once its board is ready.
   * @param closeLesson Closes the lesson window (the learner asked ECHO to).
   * @param preferences The learner's saved preferences, given to the model and written through its tools.
   */
  register(
    options: {
      canCaptureScreen?(wc: Electron.WebContents): boolean
      openLesson?(timeoutMs: number): Promise<boolean>
      closeLesson?(): void
      preferences?: PreferenceStore
      study?: StudyMaterialPort
      /** The saved judge access code, used when the app runs against ECHO's server. */
      access?: AccessCodeStore
    } = {}
  ): void {
    if (options.access) this.access = options.access
    if (options.study) this.study = options.study
    if (options.canCaptureScreen) this.canCaptureScreen = options.canCaptureScreen
    if (options.openLesson) this.openLesson = options.openLesson
    if (options.closeLesson) this.closeLesson = options.closeLesson
    if (options.preferences) {
      this.preferences = options.preferences
      // A voice chosen in the settings window applies to a conversation that is already running.
      options.preferences.subscribe(() => this.session?.onPreferencesChanged())
    }
    this.setupPermissions()
    // Test/diagnostic hook, never on by default: lets the e2e harness read the live whiteboard.
    if (!app.isPackaged && process.env.ECHO_DEBUG_HOOKS === '1') (globalThis as Record<string, unknown>).__echoBoard = board

    ipcMain.on('voice:command', (event, raw: unknown) => {
      if (this.isEngine(event.sender)) return
      const cmd = parseVoiceCommand(raw)
      if (cmd) this.handleCommand(cmd)
    })
    // Source links from the transcript open in the default browser; nothing but web URLs is accepted.
    ipcMain.on('voice:open-link', (event, url: unknown) => {
      if (!this.isEngine(event.sender) && isOpenableUrl(url)) void shell.openExternal(url)
    })
    ipcMain.handle('voice:get-state', (event): VoiceStateReply | null => {
      if (this.isEngine(event.sender)) return null
      return { snapshot: this.snapshot(), entries: this.session?.getEntries() ?? [] }
    })

    // Engine window -> main. Only the engine window is trusted on these channels.
    ipcMain.on('voice-engine:ready', (event) => {
      if (this.isEngine(event.sender)) this.session?.onEngineReady()
    })
    ipcMain.on('voice-engine:error', (event, err: unknown) => {
      if (!this.isEngine(event.sender)) return
      const e = err as Partial<EngineError> | null
      this.session?.onEngineError({
        code: e?.code ?? 'audio-error',
        message: typeof e?.message === 'string' ? e.message : 'Audio engine failed.'
      })
    })
    ipcMain.on('voice-engine:mic', (event, data: unknown) => {
      if (!this.isEngine(event.sender) || !(data instanceof Uint8Array)) return
      this.session?.onMicAudio(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    })
    ipcMain.on('voice-engine:vad', (event, speaking: unknown) => {
      if (this.isEngine(event.sender) && typeof speaking === 'boolean') this.session?.onVad(speaking)
    })
    ipcMain.on('voice-engine:barge', (event) => {
      if (this.isEngine(event.sender)) this.session?.onBargeIn()
    })
    ipcMain.on('voice-engine:playback', (event, report: unknown) => {
      if (this.isEngine(event.sender) && report && typeof report === 'object') {
        this.session?.onPlayback(report as EnginePlaybackReport)
      }
    })
  }

  toggle(): void {
    this.handleCommand({ type: 'toggle' })
  }

  isActive(): boolean {
    return !!this.session?.isActive()
  }

  /** "Go deeper" on the current conversation. False when no conversation has anything to go deeper on. */
  deepDive(): boolean {
    return !!this.session?.deepDive()
  }

  /** Send or Cancel pressed on the draft card. */
  answerDraft(id: string, send: boolean): void {
    this.session?.answerDraft(id, send)
  }

  editDraft(id: string, edits: DraftEdits): void {
    this.session?.editDraft(id, edits)
  }

  /** The deck window's own arrows and arrow keys. */
  selectSlide(index: number): void {
    this.decks.select(index)
  }

  private createDeckStudio(): DeckStudio {
    const pictures = withEchoPicture(() => this.pictures ?? undefined)
    return new DeckStudio(
      {
        show: showDeck,
        close: closeDeck,
        isOpen: isDeckOpen,
        save: async (deck, format) => {
          const path = await saveDeck(deck, format, app.getPath('documents'), printDeck)
          const failed = await shell.openPath(path)
          if (failed) console.log(`[deck] saved, but could not open it: ${failed}`)
          return path
        },
        pictures
      },
      (m) => console.log(m)
    )
  }

  /** Ends any conversation (used on app quit). */
  shutdown(): void {
    this.session?.stop()
  }

  private isEngine(sender: Electron.WebContents): boolean {
    return !!this.engine && !this.engine.isDestroyed() && sender === this.engine.webContents
  }

  // --- Commands from the UI -----------------------------------------------------------------

  private handleCommand(cmd: VoiceCommand): void {
    switch (cmd.type) {
      case 'start':
        void this.start()
        return
      case 'stop':
        this.session?.stop()
        this.configError = null
        this.broadcast({ type: 'state', snapshot: this.snapshot() })
        return
      case 'toggle':
        if (this.session?.isActive()) this.handleCommand({ type: 'stop' })
        else void this.start()
        return
      case 'mute':
        this.session?.setMuted(cmd.muted)
        return
      case 'interrupt':
        this.session?.stopResponse()
        return
      case 'push-to-talk-mode':
        this.session?.setPushToTalkMode(cmd.enabled)
        return
      case 'talk':
        this.session?.talk(cmd.pressed)
        return
    }
  }

  private async start(): Promise<void> {
    if (this.session?.isActive()) return
    if (!this.envLoaded) {
      loadEnvFiles([app.getAppPath(), process.cwd(), app.getPath('userData')])
      this.envLoaded = true
    }
    // ECHO's server and its access code (built in, so judges don't have to enter anything; see accessCode.ts).
    const result = readVoiceConfig({
      ...process.env,
      ECHO_BACKEND_URL: backendUrl(),
      ECHO_ACCESS_CODE: accessCodeFor(this.access)
    })
    if (!result.ok) {
      this.configError = { ...IDLE_SNAPSHOT, state: 'error', message: result.message }
      this.broadcast({ type: 'state', snapshot: this.configError })
      return
    }
    this.configError = null

    // Chromium's fake capture device (end-to-end tests) never touches the real microphone, so there is
    // nothing to ask permission for.
    if (process.platform === 'darwin' && !app.commandLine.hasSwitch('use-fake-device-for-media-stream')) {
      const granted = await systemPreferences.askForMediaAccess('microphone').catch(() => false)
      if (!granted) {
        this.configError = {
          ...IDLE_SNAPSHOT,
          state: 'error',
          message: 'Microphone access is turned off. Enable it for ECHO in System Settings → Privacy & Security → Microphone.'
        }
        this.broadcast({ type: 'state', snapshot: this.configError })
        return
      }
    }

    // A new session object per configuration keeps model/voice env changes honest.
    const cfg = result.config
    const chat = new ClaudeChat(cfg)
    const deepgramAuth = deepgramAuthFor(cfg)
    if (cfg.backend) console.log(`[voice] using ECHO server ${new URL(cfg.backend.url).host}`)
    const prev = this.session?.getSnapshot()
    this.session = new VoiceSession({
      config: cfg,
      engine: this.enginePort,
      createStt: (hooks) => new FluxClient(cfg, hooks, deepgramAuth),
      // The saved voice wins over the env default, and is read each time a speech socket is opened.
      createTts: (hooks) => new DeepgramTts({ ...cfg, ttsVoice: this.preferences?.get('voice') ?? cfg.ttsVoice }, hooks, deepgramAuth),
      chat,
      lesson: {
        available: () => cfg.visualsEnabled && isBoardOpen(),
        board: () => (isBoardOpen() ? board : null),
        open: (timeoutMs) => (cfg.visualsEnabled ? this.openLesson(timeoutMs) : Promise.resolve(false)),
        close: () => this.closeLesson(),
        ...(cfg.picturesEnabled ? { pictures: (this.pictures ??= new CommonsPictures()) } : {})
      },
      ...(this.preferences ? { preferences: this.preferences } : {}),
      ...(this.study ? { study: this.study } : {}),
      contextProvider: screenVoiceContext,
      compose: {
        destinations: cfg.composeDestinations,
        show: showDraft,
        // The text also goes on the clipboard, in case the page drops part of a long draft.
        open: (draft: Draft) => {
          clipboard.writeText(draft.body)
          void shell.openExternal(composeUrl(draft))
        }
      },
      ...(cfg.decksEnabled ? { deck: this.decks } : {}),
      emit: (e) => this.broadcast(e),
      log: (m) => console.log(m)
    })
    if (prev) {
      // Preserve the user's mute / push-to-talk preference across restarts of the conversation.
      this.session.setPushToTalkMode(prev.pushToTalk)
      this.session.setMuted(prev.muted)
    }
    this.session.start()
  }

  private snapshot(): VoiceSnapshot {
    if (this.configError && !this.session?.isActive()) return this.configError
    return this.session?.getSnapshot() ?? IDLE_SNAPSHOT
  }

  private broadcast(event: VoiceEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === this.engine || win.isDestroyed()) continue
      win.webContents.send('voice:event', event)
    }
  }

  // --- Audio engine window ------------------------------------------------------------------------

  private toEngine(channel: string, ...args: unknown[]): void {
    const win = this.engine
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
  }

  private openEngine(muted: boolean, bargeInMs: number): void {
    this.closeEngine()
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/voiceEngine.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Audio capture and playback must keep running while the window is hidden.
        backgroundThrottling: false
      }
    })
    this.engine = win

    win.webContents.once('did-finish-load', () => {
      if (this.engine === win) this.toEngine('voice-engine:start', { muted, bargeInMs })
    })
    win.on('closed', () => {
      if (this.engine !== win) return
      this.engine = null
      this.session?.onEngineError({ code: 'audio-error', message: 'The audio engine stopped unexpectedly.' })
    })
    win.webContents.on('render-process-gone', () => {
      if (this.engine === win) this.session?.onEngineError({ code: 'audio-error', message: 'The audio engine crashed.' })
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/voice-engine.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/voice-engine.html'))
    }
    if (isDev && process.env.ECHO_DEBUG_ENGINE === '1') win.webContents.openDevTools({ mode: 'detach' })
  }

  private closeEngine(): void {
    const win = this.engine
    this.engine = null // detach first so 'closed' isn't treated as a crash
    if (win && !win.isDestroyed()) {
      this.toEngineOn(win, 'voice-engine:stop')
      win.destroy()
    }
  }

  private toEngineOn(win: BrowserWindow, channel: string): void {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel)
  }

  // --- Permissions --------------------------------------------------------------------------------------

  /**
   * Microphone is granted only to the audio engine window, and only for audio.
   * Screen capture is granted only to the window that owns screen sharing.
   */
  private setupPermissions(): void {
    const ses = electronSession.defaultSession
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'display-capture') return callback(this.canCaptureScreen(wc))
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      const only = (type: string): boolean => mediaTypes.length > 0 && mediaTypes.every((t) => t === type)
      // getDisplayMedia arrives here as a media request with no media types
      // (they only describe camera / microphone devices).
      const screenShare = this.canCaptureScreen(wc) && (mediaTypes.length === 0 || only('video'))
      const granted = permission === 'media' && ((this.isEngine(wc) && only('audio')) || screenShare)
      if (!granted) {
        console.log(`[permissions] denied ${permission} (${mediaTypes.join(', ') || 'no media types'}) for ${wc.getURL()}`)
      }
      callback(granted)
    })
    ses.setPermissionCheckHandler((wc, permission) => {
      if (!wc) return false
      if (permission === 'display-capture') return this.canCaptureScreen(wc)
      return permission === 'media' && (this.isEngine(wc) || this.canCaptureScreen(wc))
    })
  }
}

export const voiceHost = new VoiceHost()
