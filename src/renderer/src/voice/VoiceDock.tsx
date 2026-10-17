import { memo, useEffect, useRef, type PointerEvent } from 'react'
import type { TranscriptEntry, VoiceState } from '../../../shared/voice'
import { useVoice } from './useVoice'

const LABEL: Record<VoiceState, string> = {
  idle: 'Voice off',
  connecting: 'Connecting…',
  listening: 'Listening',
  'user-speaking': 'Hearing you',
  thinking: 'Thinking…',
  speaking: 'ECHO is speaking',
  paused: 'Mic muted',
  error: 'Voice problem'
}

const send = window.voice.command

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg className="vd-icon" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  )
}

const MicIcon = () => (
  <Icon>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Icon>
)
const MicOffIcon = () => (
  <Icon>
    <path d="M9 9v2a3 3 0 0 0 5 2.2M15 10.5V6a3 3 0 0 0-5.7-1.3M5.5 11a6.5 6.5 0 0 0 10.2 5.3M18.5 11a6.5 6.5 0 0 1-.6 2.7M12 17.5V21M4 4l16 16" />
  </Icon>
)
const StopIcon = () => (
  <Icon>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
  </Icon>
)
const PowerIcon = () => (
  <Icon>
    <path d="M12 3v8M7.2 6.6a7 7 0 1 0 9.6 0" />
  </Icon>
)
const HandIcon = () => (
  <Icon>
    <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5v-1a1.5 1.5 0 0 1 3 0V11m0-4a1.5 1.5 0 0 1 3 0v6.5c0 3.6-2.4 6-5.5 6S6 17 5 14.5l-1-2.2a1.4 1.4 0 0 1 2.4-1.4L8 13" />
  </Icon>
)

/** One transcript line. Memoized so a streaming reply re-renders only its own line. */
const Line = memo(function Line({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === 'user') {
    return (
      <p className={`vd-line vd-user${entry.final ? '' : ' is-live'}`}>
        <span className="vd-who">You</span> {entry.text}
      </p>
    )
  }
  const spoken = Math.min(entry.spokenChars ?? 0, entry.text.length)
  return (
    <p className={`vd-line vd-echo${entry.interrupted ? ' is-interrupted' : ''}`}>
      <span className="vd-who">ECHO</span> <span className="vd-spoken">{entry.text.slice(0, spoken)}</span>
      <span className="vd-pending">{entry.text.slice(spoken)}</span>
      {entry.interrupted && <span className="vd-cut"> — interrupted</span>}
      {entry.searchFailed && <span className="vd-cut"> — web search failed, answered from memory</span>}
      {entry.final && entry.sources?.length ? (
        <span className="vd-sources">
          Sources:
          {entry.sources.map((s) => (
            <button
              key={s.url}
              className={`vd-source${s.cited ? '' : ' is-found'}`}
              title={`${s.cited ? '' : 'Found, not cited · '}${s.url}`}
              onClick={() => window.voice.openLink(s.url)}
            >
              {s.title}
            </button>
          ))}
        </span>
      ) : null}
    </p>
  )
})

export function VoiceDock() {
  const { snapshot, entries, lesson } = useVoice()
  const log = useRef<HTMLDivElement>(null)
  const { state, muted, pushToTalk, talking, message } = snapshot
  const active = state !== 'idle' && state !== 'error'
  const busy = state === 'thinking' || state === 'speaking'

  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const hold = {
    onPointerDown(e: PointerEvent<HTMLButtonElement>) {
      e.currentTarget.setPointerCapture(e.pointerId)
      send({ type: 'talk', pressed: true })
    },
    onPointerUp: () => send({ type: 'talk', pressed: false }),
    onPointerCancel: () => send({ type: 'talk', pressed: false })
  }

  return (
    <div className="voice-dock" data-state={state}>
      {(entries.length > 0 || message) && (
        <div className="vd-panel" ref={log} aria-live="polite">
          {entries.map((e) => (
            <Line key={e.id} entry={e} />
          ))}
          {message && <p className="vd-line vd-message">{message}</p>}
        </div>
      )}

      {lesson && (
        <div className={`vd-lesson is-${lesson.level}`} role="status" aria-live="polite">
          {lesson.message}
        </div>
      )}

      <div className="vd-bar" role="toolbar" aria-label="Voice conversation">
        <span className="vd-status">
          <span className="vd-dot" aria-hidden="true" />
          {LABEL[state]}
        </span>
        <span className="vd-sep" aria-hidden="true" />

        <button
          className={`vd-btn${active ? ' is-on' : ''}`}
          onClick={() => send({ type: 'toggle' })}
          title={active ? 'End conversation' : 'Start conversation'}
          aria-pressed={active}
        >
          <PowerIcon />
          <span>{active ? 'End' : 'Talk to ECHO'}</span>
        </button>

        {active && (
          <>
            <button
              className={`vd-btn vd-icon-btn${muted ? ' is-warn' : ''}`}
              onClick={() => send({ type: 'mute', muted: !muted })}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={muted}
            >
              {muted ? <MicOffIcon /> : <MicIcon />}
            </button>
            <button
              className="vd-btn vd-icon-btn"
              onClick={() => send({ type: 'interrupt' })}
              disabled={!busy}
              title="Stop ECHO"
            >
              <StopIcon />
            </button>
            <button
              className={`vd-btn vd-icon-btn${pushToTalk ? ' is-on' : ''}`}
              onClick={() => send({ type: 'push-to-talk-mode', enabled: !pushToTalk })}
              title={pushToTalk ? 'Switch to hands-free' : 'Push-to-talk mode'}
              aria-pressed={pushToTalk}
            >
              <HandIcon />
            </button>
            {pushToTalk && (
              <button className={`vd-btn vd-hold${talking ? ' is-on' : ''}`} {...hold} title="Hold to talk">
                {talking ? 'Release to send' : 'Hold to talk'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
