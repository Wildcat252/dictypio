import { useCallback, useEffect, useState } from 'react'
import axios from 'axios'
import { api, waitForServer } from '../../api'
import type { Lesson } from '../../contexts/WorkspaceContext'

/**
 * Bytes asked for per request. The API runs on Cloud Run, which cuts plain
 * responses above 32 MiB, so a long lesson's audio comes in ranges; the
 * server caps each answer at 8 MiB anyway.
 */
export const AUDIO_CHUNK_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const FETCH_ATTEMPTS = 4
const RETRY_MS = 1500

export interface AudioError {
  /** missing: the server no longer has it; unreachable: try again later */
  kind: 'missing' | 'unreachable'
  message: string
}

const UNREACHABLE: AudioError = {
  kind: 'unreachable',
  message: "Can't reach the server to load this lesson's audio.",
}
const NO_AUDIO: AudioError = {
  kind: 'missing',
  message:
    'This lesson has no audio on the server. Import the same YouTube link again to restore it; your progress is kept.',
}

interface RangeResponse {
  status: number
  data: Blob
  headers: Record<string, unknown>
}
type RangeGetter = (
  url: string,
  config: { responseType: 'blob'; headers: Record<string, string>; signal: AbortSignal; timeout: number }
) => Promise<RangeResponse>

export function parseContentRange(value: unknown): { start: number; end: number; total: number } | null {
  if (typeof value !== 'string') return null
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim())
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) }
}

/**
 * Download a whole file as consecutive byte ranges and join them. A server
 * that ignores Range (200) hands over the whole file in the first answer.
 */
export async function fetchInRanges(get: RangeGetter, url: string, signal: AbortSignal): Promise<Blob> {
  const parts: Blob[] = []
  let type = ''
  let offset = 0
  for (;;) {
    const asked = AUDIO_CHUNK_BYTES
    let res: RangeResponse
    try {
      res = await get(url, {
        responseType: 'blob',
        headers: { Range: `bytes=${offset}-${offset + asked - 1}` },
        signal,
        timeout: REQUEST_TIMEOUT_MS,
      })
    } catch (err) {
      // The size was an exact multiple of the chunk and no total was readable.
      if (offset > 0 && axios.isAxiosError(err) && err.response?.status === 416) break
      throw err
    }
    const blob = res.data
    if (!type) type = blob.type
    if (res.status !== 206) {
      if (offset === 0) return blob
      throw new Error('The server stopped sending the audio in parts')
    }
    parts.push(blob)
    const range = parseContentRange(res.headers['content-range'])
    if (range) {
      if (range.start !== offset) throw new Error('The server sent the wrong part of the audio')
      offset = range.end + 1
      if (offset >= range.total) break
    } else {
      // Total not readable (header not exposed): a short part is the last one.
      offset += blob.size
      if (blob.size < asked) break
    }
    if (blob.size === 0) throw new Error('The server sent an empty part of the audio')
  }
  return new Blob(parts, { type: type || 'audio/mp4' })
}

/** The `detail` of an error answer; with responseType 'blob' it arrives as a Blob. */
async function errorDetail(data: unknown): Promise<string | null> {
  try {
    const text = data instanceof Blob ? await data.text() : typeof data === 'string' ? data : null
    if (text) {
      const detail = (JSON.parse(text) as { detail?: unknown }).detail
      return typeof detail === 'string' ? detail : null
    }
    const detail = (data as { detail?: unknown } | null)?.detail
    return typeof detail === 'string' ? detail : null
  } catch {
    return null
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/**
 * The audio of an audio (YouTube) lesson, fetched with the auth header and
 * handed to the <audio> element as a blob URL. Text (TTS) lessons have none.
 *
 * `audioBlobUrl` is only ever the current lesson's: right after a switch it is
 * null rather than the previous lesson's. A failure ends in `audioError`
 * instead of loading forever; `retryAudio` starts over.
 */
export function useLessonAudio(lesson: Lesson | null) {
  const videoId = lesson?.video_id ?? null
  const isTextLesson = Boolean(lesson?.youtube_url?.startsWith('text://'))
  const audioPath = lesson?.audio_file_path ?? null
  const needsAudio = videoId !== null && !isTextLesson

  const [loaded, setLoaded] = useState<{ videoId: number; url: string } | null>(null)
  const [failure, setFailure] = useState<{ videoId: number; error: AudioError } | null>(null)
  const [attemptKey, setAttemptKey] = useState(0)
  const retryAudio = useCallback(() => setAttemptKey((k) => k + 1), [])

  useEffect(() => {
    setFailure(null)
    if (!needsAudio || videoId === null) return
    if (!audioPath) {
      setFailure({ videoId, error: NO_AUDIO })
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    let url: string | null = null
    ;(async () => {
      let error: AudioError = UNREACHABLE
      for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
        // The server may be waking up; when it never answers there is no use
        // in asking it for audio.
        if (!(await waitForServer())) break
        if (signal.aborted) return
        try {
          const blob = await fetchInRanges(api.get, `/api/youtube/videos/${videoId}/audio`, signal)
          if (signal.aborted) return
          url = URL.createObjectURL(blob)
          setLoaded({ videoId, url })
          return
        } catch (err) {
          if (signal.aborted) return
          const status = axios.isAxiosError(err) ? err.response?.status : undefined
          if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
            // Asking again gives the same answer.
            const detail = await errorDetail(axios.isAxiosError(err) ? err.response?.data : null)
            error = status === 404
              ? { kind: 'missing', message: detail ?? NO_AUDIO.message }
              : { kind: 'unreachable', message: detail ?? UNREACHABLE.message }
            break
          }
          error = UNREACHABLE
          await sleep(RETRY_MS * (attempt + 1), signal)
          if (signal.aborted) return
        }
      }
      if (!signal.aborted) setFailure({ videoId, error })
    })()
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
      setLoaded((prev) => (prev && prev.url === url ? null : prev))
    }
  }, [needsAudio, videoId, audioPath, attemptKey])

  const audioBlobUrl = loaded && loaded.videoId === videoId ? loaded.url : null
  const audioError = failure && failure.videoId === videoId && !audioBlobUrl ? failure.error : null
  return {
    audioBlobUrl,
    audioError,
    retryAudio,
    /** Nothing to wait for: a text lesson, or this lesson's audio is loaded. */
    audioReady: !needsAudio || audioBlobUrl !== null,
  }
}
