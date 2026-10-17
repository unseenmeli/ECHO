import { readFileSync } from 'node:fs'
import { app, Menu, nativeImage, Tray } from 'electron'
import iconPath from '../../resources/trayTemplate@2x.png?asset'

export interface TrayActions {
  isCompanionVisible(): boolean
  toggleCompanion(): void
  openLesson(): void
  toggleVoice(): void
  isVoiceActive(): boolean
}

// Module-level reference: a Tray that gets garbage-collected disappears.
let tray: Tray | null = null

/**
 * The app's only persistent UI besides the companion itself: a menu-bar item
 * on macOS (the app has no Dock icon) and a notification-area icon on Windows.
 */
export function createTray(actions: TrayActions): void {
  const isMac = process.platform === 'darwin'

  // The white 2x template image is used on every platform; macOS tints it to
  // match light/dark menu bars.
  const icon = nativeImage.createFromBuffer(readFileSync(iconPath), { scaleFactor: 2 })
  if (isMac) icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Echo')

  // Built on demand so the Show/Hide label reflects the current state.
  const showMenu = (): void => {
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: actions.isCompanionVisible() ? 'Hide Echo' : 'Show Echo', click: actions.toggleCompanion },
        { label: 'Open Lesson', click: actions.openLesson },
        { label: actions.isVoiceActive() ? 'End Conversation' : 'Start Conversation', click: actions.toggleVoice },
        { type: 'separator' },
        { label: 'Quit Echo', click: () => app.quit() }
      ])
    )
  }

  // macOS convention: any click opens the menu. Windows convention: left
  // click toggles the companion, right click opens the menu.
  tray.on('click', isMac ? showMenu : actions.toggleCompanion)
  tray.on('right-click', showMenu)
}
