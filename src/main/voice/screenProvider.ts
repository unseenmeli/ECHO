import { screenContext, type ScreenFrame } from '../screenContext'
import type { VoiceContext, VoiceContextProvider } from './ports'

// The capture includes ECHO's own windows (they're deliberately not hidden so
// they show up in screen recordings), so tell the model what they are.
const SELF_NOTE =
  'The small cartoon character with spiky hair floating on the screen, and any window titled "Lesson", are you (ECHO). Ignore them unless the user asks about them.'

async function currentFrame(): Promise<ScreenFrame | null> {
  try {
    return await screenContext.captureFresh()
  } catch {
    // Interval frames are only skipped when nothing changed, so while sharing
    // the latest one still shows the screen as it is.
    return screenContext.latest()
  }
}

/** Gives every voice reply a screenshot taken as the user finished speaking, whenever sharing is on. */
export const screenVoiceContext: VoiceContextProvider = {
  isWatchingScreen: () => screenContext.state().status === 'sharing',

  async getContext(): Promise<VoiceContext> {
    const { status } = screenContext.state()
    if (status === 'off') {
      return {
        screen:
          'The user is not sharing their screen, so you cannot see it. Do not bring this up on your own. If they ask about something on it, say so and tell them to choose "Share Screen…" from ECHO\'s menu-bar icon.'
      }
    }
    if (status === 'paused') {
      return {
        screen:
          'The user paused screen watching, so you cannot see their screen right now. Do not bring this up on your own. If they ask about it, tell them to click the "Paused" pill above you to resume.'
      }
    }
    const frame = await currentFrame()
    if (!frame) {
      return {
        screen:
          "The user is sharing their screen, but no picture has arrived yet. If they ask about it, say you couldn't get a look and ask them to try again in a second."
      }
    }
    const source = frame.sourceLabel ? `"${frame.sourceLabel}"` : 'their screen'
    return {
      screen: `The image attached to the user's latest message is a live screenshot of ${source}, taken as they finished speaking. Use it only when their turn is about what's on screen, and then describe only what you can actually see in it. Otherwise don't mention it. ${SELF_NOTE}`,
      screenImage: { mediaType: frame.mimeType, data: frame.data.toString('base64') }
    }
  }
}
