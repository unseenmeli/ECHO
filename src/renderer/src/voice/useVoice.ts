import { useEffect, useState } from 'react'
import { IDLE_SNAPSHOT, type LessonStatus, type TranscriptEntry, type VoiceSnapshot } from '../../../shared/voice'

export interface VoiceView {
  snapshot: VoiceSnapshot
  entries: TranscriptEntry[]
  /** Subtle whiteboard status ("Preparing the drawing…"), or null. */
  lesson: LessonStatus | null
}

/**
 * Subscribes a window to the voice session. Entries are replaced by id, so a
 * streaming reply updates one item rather than rebuilding the transcript.
 */
export function useVoice(): VoiceView {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(IDLE_SNAPSHOT)
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [lesson, setLesson] = useState<LessonStatus | null>(null)

  useEffect(() => {
    let live = true
    const off = window.voice.onEvent((event) => {
      if (!live) return
      switch (event.type) {
        case 'state':
          setSnapshot(event.snapshot)
          return
        case 'reset':
          setEntries([])
          setLesson(null)
          return
        case 'lesson-status':
          setLesson(event.status.message ? event.status : null)
          return
        case 'lesson-metrics':
          return
        case 'entry': {
          const incoming = event.entry
          setEntries((prev) => {
            const i = prev.findIndex((e) => e.id === incoming.id)
            if (incoming.final && incoming.text === '') return i >= 0 ? prev.filter((e) => e.id !== incoming.id) : prev
            if (i < 0) return [...prev, incoming].slice(-40)
            const next = prev.slice()
            next[i] = incoming
            return next
          })
          return
        }
        case 'metrics':
          return
      }
    })
    // Windows opened mid-conversation catch up from the main process.
    void window.voice.getState().then((reply) => {
      if (!live || !reply) return
      setSnapshot(reply.snapshot)
      setEntries((prev) => (prev.length ? prev : reply.entries))
    })
    return () => {
      live = false
      off()
    }
  }, [])

  return { snapshot, entries, lesson }
}
