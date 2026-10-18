import { readFile } from 'node:fs/promises'
import { nativeImage } from 'electron'
import echoArtPath from '../../../resources/echo-art.jpeg?asset'
import { isEchoPictureSearch } from '../../shared/deck'
import type { Picture, PictureLookup } from '../lesson/pictures'

// ECHO's own character art, for slides about ECHO. Commons has no picture of ECHO, so this one is bundled with the
// app; every other search goes to the usual lookup.

async function loadEchoArt(): Promise<Picture> {
  const data = await readFile(echoArtPath)
  const { width, height } = nativeImage.createFromBuffer(data).getSize()
  return {
    fileId: 'echo-art',
    dataURL: `data:image/jpeg;base64,${data.toString('base64')}`,
    mimeType: 'image/jpeg',
    width,
    height,
    title: 'ECHO',
    credit: "ECHO's character art",
    pageUrl: ''
  }
}

/** @param fallback The lookup for everything else (absent while pictures are off). */
export function withEchoPicture(fallback: () => PictureLookup | undefined): PictureLookup {
  let echo: Promise<Picture> | null = null
  return {
    find(req, signal) {
      if (isEchoPictureSearch(req.search)) {
        echo ??= loadEchoArt().catch((err) => {
          echo = null
          throw err
        })
        return echo
      }
      return fallback()?.find(req, signal) ?? Promise.resolve(null)
    }
  }
}
