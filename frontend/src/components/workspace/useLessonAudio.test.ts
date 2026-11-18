import { describe, expect, it } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
import { AUDIO_CHUNK_BYTES, fetchInRanges, parseContentRange } from './useLessonAudio'

type Config = { headers: Record<string, string> }

/** A fake server holding `size` bytes that answers ranges, capping each at `cap`. */
function server(size: number, opts: { cap?: number; exposeRange?: boolean; ignoreRange?: boolean } = {}) {
  const bytes = new Uint8Array(size).map((_, i) => i % 251)
  const asked: string[] = []
  const get = async (_url: string, config: Config) => {
    const range = config.headers.Range
    asked.push(range)
    if (opts.ignoreRange) return { status: 200, data: new Blob([bytes], { type: 'audio/mp4' }), headers: {} }
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!
    const start = Number(m[1])
    if (start >= size) {
      const response = { status: 416, data: new Blob(), headers: {}, statusText: '', config: { headers: new AxiosHeaders() } }
      throw new AxiosError('416', 'ERR_BAD_REQUEST', undefined, undefined, response as never)
    }
    const end = Math.min(Number(m[2]), size - 1, start + (opts.cap ?? Infinity) - 1)
    return {
      status: 206,
      data: new Blob([bytes.slice(start, end + 1)], { type: 'audio/mp4' }),
      headers: opts.exposeRange === false ? {} : { 'content-range': `bytes ${start}-${end}/${size}` },
    }
  }
  return { bytes, asked, get }
}

/** Whether the blob holds exactly these bytes (toEqual on megabytes is too slow). */
async function sameBytes(blob: Blob, bytes: Uint8Array) {
  const got = new Uint8Array(await blob.arrayBuffer())
  if (got.length !== bytes.length) return false
  for (let i = 0; i < got.length; i++) if (got[i] !== bytes[i]) return false
  return true
}

describe('fetchInRanges', () => {
  const signal = new AbortController().signal

  it('joins consecutive parts into the whole file', async () => {
    const size = AUDIO_CHUNK_BYTES * 2 + 123
    const s = server(size)
    const blob = await fetchInRanges(s.get, '/a', signal)
    expect(s.asked).toHaveLength(3)
    expect(await sameBytes(blob, s.bytes)).toBe(true)
    expect(blob.type).toBe('audio/mp4')
  })

  it('follows a server that sends less than asked', async () => {
    const s = server(1000, { cap: 300 })
    expect(await sameBytes(await fetchInRanges(s.get, '/a', signal), s.bytes)).toBe(true)
    expect(s.asked).toEqual(['bytes=0-4194303', 'bytes=300-4194603', 'bytes=600-4194903', 'bytes=900-4195203'])
  })

  it('copes without a readable Content-Range', async () => {
    const short = server(500, { exposeRange: false })
    expect(await sameBytes(await fetchInRanges(short.get, '/a', signal), short.bytes)).toBe(true)
    // An exact multiple of the part size ends on the 416 for the next part.
    const exact = server(AUDIO_CHUNK_BYTES, { exposeRange: false })
    expect((await fetchInRanges(exact.get, '/a', signal)).size).toBe(AUDIO_CHUNK_BYTES)
  })

  it('takes a whole-file answer from a server without ranges', async () => {
    const s = server(700, { ignoreRange: true })
    expect(await sameBytes(await fetchInRanges(s.get, '/a', signal), s.bytes)).toBe(true)
    expect(s.asked).toHaveLength(1)
  })
})

describe('parseContentRange', () => {
  it('reads the header', () => {
    expect(parseContentRange('bytes 0-99/1000')).toEqual({ start: 0, end: 99, total: 1000 })
    expect(parseContentRange('bytes */1000')).toBeNull()
    expect(parseContentRange(undefined)).toBeNull()
  })
})
