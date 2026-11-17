/**
 * Google Cloud Text-to-Speech playback.
 *
 * Clips come from POST /api/tts as MP3 and are kept in IndexedDB, so a
 * sentence is fetched from Google once per browser and replayed for free after
 * that. Speed is applied with playbackRate, so one clip serves every speed.
 *
 * A CloudUtterance mirrors the parts of SpeechSynthesisUtterance the players
 * use (text, rate, onstart/onend/onerror), so Workspace and Practice can hand
 * either kind to the same code. When a clip cannot be had — the free-tier
 * quota is used up, the network failed — it is read with a browser voice
 * instead, so playback never stops.
 */
import { api } from './api'
import { alternateGoogleVoice, fallbackBrowserVoice, type AppVoice, type GoogleTier } from './voices'

export class CloudUtterance {
  rate = 1
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: Event) => void) | null = null
  constructor(
    public text: string,
    public voice: AppVoice
  ) {}
}

export type AnyUtterance = SpeechSynthesisUtterance | CloudUtterance

/** An utterance for `voice`: a CloudUtterance for Google voices, else a browser one. */
export function makeUtterance(text: string, voice: AppVoice | null, rate: number): AnyUtterance {
  if (voice?.source === 'google') {
    const u = new CloudUtterance(text, voice)
    u.rate = rate
    return u
  }
  const u = new SpeechSynthesisUtterance(text)
  u.rate = rate
  if (voice?.browserVoice) u.voice = voice.browserVoice
  return u
}

// --- notices -----------------------------------------------------------------

/** Fired (once per cause per page load) when playback had to fall back to a browser voice. */
export const TTS_NOTICE_EVENT = 'tts:notice'
export interface TtsNotice {
  kind: 'quota' | 'error'
  tier?: GoogleTier
  period?: 'month' | 'day'
  /** What reads instead: another Google family, or a browser voice. */
  fallback?: GoogleTier | 'browser'
}

const noticed = new Set<string>()
function notify(notice: TtsNotice) {
  const key = `${notice.kind}:${notice.tier ?? ''}:${notice.period ?? ''}`
  if (noticed.has(key)) return
  noticed.add(key)
  window.dispatchEvent(new CustomEvent<TtsNotice>(TTS_NOTICE_EVENT, { detail: notice }))
}

// Voice families whose quota ran out this page load: read with browser voices
// straight away instead of asking the server again for every word.
// The period is kept so later notices name the limit that was actually hit.
const exhausted = new Map<GoogleTier, 'month' | 'day'>()
const ALL_TIERS: GoogleTier[] = ['chirp3hd', 'neural2']

function markExhausted(tier: GoogleTier, period: 'month' | 'day') {
  // The daily allowance is per user across every family, so the other family
  // is used up too: asking it would only earn a second 429.
  const tiers = period === 'day' ? ALL_TIERS : [tier]
  for (const t of tiers) if (!exhausted.has(t)) exhausted.set(t, period)
}

class QuotaError extends Error {
  constructor(
    public tier: GoogleTier,
    public period: 'month' | 'day'
  ) {
    super('Text-to-Speech quota used up')
  }
}

// --- clip cache (memory + IndexedDB) -----------------------------------------

const DB_NAME = 'dictypio-tts'
const STORE = 'clips'
/** Past this the least recently played clips are dropped. */
const MAX_CACHE_BYTES = 100 * 1024 * 1024
const PRUNE_EVERY_N_PUTS = 25
const MEMORY_CLIPS = 200

interface ClipRecord {
  key: string
  blob: Blob
  size: number
  lastUsed: number
}

const memory = new Map<string, Blob>()
const inFlight = new Map<string, Promise<Blob>>()
let putsSincePrune = 0

const clipKey = (text: string, voice: string) => `${voice}\n${text.trim()}`

function remember(key: string, blob: Blob) {
  memory.delete(key)
  memory.set(key, blob)
  if (memory.size > MEMORY_CLIPS) memory.delete(memory.keys().next().value as string)
}

let dbPromise: Promise<IDBDatabase | null> | null = null
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('lastUsed', 'lastUsed')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      // No IndexedDB (some private modes): clips just live in memory.
      resolve(null)
    }
  })
  return dbPromise
}

async function dbGet(key: string): Promise<Blob | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.get(key)
      req.onsuccess = () => {
        const rec = req.result as ClipRecord | undefined
        if (!rec) return resolve(null)
        rec.lastUsed = Date.now()
        store.put(rec)
        resolve(rec.blob)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function dbPut(key: string, blob: Blob): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ key, blob, size: blob.size, lastUsed: Date.now() } satisfies ClipRecord)
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    return
  }
  if (++putsSincePrune >= PRUNE_EVERY_N_PUTS) {
    putsSincePrune = 0
    void prune(db)
  }
}

/** Drop the least recently played clips until the cache fits MAX_CACHE_BYTES. */
async function prune(db: IDBDatabase): Promise<void> {
  try {
    const sizes: { key: string; size: number }[] = []
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).index('lastUsed').openCursor() // oldest first
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) return resolve()
        const rec = cursor.value as ClipRecord
        sizes.push({ key: rec.key, size: rec.size })
        cursor.continue()
      }
      req.onerror = () => resolve()
    })
    let total = sizes.reduce((sum, s) => sum + s.size, 0)
    if (total <= MAX_CACHE_BYTES) return
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const s of sizes) {
      if (total <= MAX_CACHE_BYTES * 0.9) break
      store.delete(s.key)
      total -= s.size
    }
  } catch {
    // Best effort.
  }
}

async function fetchClip(text: string, voice: AppVoice): Promise<Blob> {
  try {
    const res = await api.post<Blob>(
      '/api/tts',
      { text: text.trim(), voice: voice.name },
      { responseType: 'blob' }
    )
    return res.data
  } catch (err) {
    const e = err as { response?: { status?: number; data?: Blob } }
    if (e.response?.status === 429) {
      let period: 'month' | 'day' = 'month'
      try {
        const body = JSON.parse((await e.response.data?.text()) ?? '{}')
        if (body?.detail?.period === 'day') period = 'day'
      } catch {
        // keep 'month'
      }
      throw new QuotaError(voice.tier ?? 'chirp3hd', period)
    }
    throw err
  }
}

/** The MP3 for `text` in a Google `voice`: memory, then IndexedDB, then the server. */
export function getClip(text: string, voice: AppVoice): Promise<Blob> {
  const key = clipKey(text, voice.name)
  const hit = memory.get(key)
  if (hit) {
    remember(key, hit)
    return Promise.resolve(hit)
  }
  const pending = inFlight.get(key)
  if (pending) return pending

  const load = (async () => {
    const stored = await dbGet(key)
    if (stored) {
      remember(key, stored)
      return stored
    }
    const usedUp = voice.tier ? exhausted.get(voice.tier) : undefined
    if (voice.tier && usedUp) throw new QuotaError(voice.tier, usedUp)
    const blob = await fetchClip(text, voice)
    remember(key, blob)
    void dbPut(key, blob)
    return blob
  })()
  inFlight.set(key, load)
  load.finally(() => inFlight.delete(key)).catch(() => {})
  return load
}

/** Start loading a clip that is about to be needed, so it plays without a wait. */
export function prefetchClip(text: string, voice: AppVoice | null | undefined): void {
  if (!text.trim() || voice?.source !== 'google') return
  if (voice.tier && exhausted.has(voice.tier)) return
  getClip(text, voice).catch((err) => {
    if (err instanceof QuotaError) markExhausted(err.tier, err.period)
  })
}

// --- playback ----------------------------------------------------------------

let audioEl: HTMLAudioElement | null = null
let currentUrl: string | null = null
// Bumped by every speak/cancel; a callback whose token is stale belongs to
// playback that was abandoned and must do nothing.
let playToken = 0
let fallbackSpeaking = false

function audio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio()
    audioEl.preload = 'auto'
  }
  return audioEl
}

function stopAudio() {
  if (audioEl) {
    audioEl.onended = null
    audioEl.onerror = null
    audioEl.pause()
    // Detach before revoking, or the element may still read from the revoked
    // URL while buffering and log ERR_FILE_NOT_FOUND.
    if (currentUrl && audioEl.src === currentUrl) {
      audioEl.removeAttribute('src')
      audioEl.load()
    }
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
}

/** Read `u` with a browser voice, for when its Google clip is unavailable. */
function speakFallback(u: CloudUtterance, token: number) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (!synth) {
    u.onerror?.(new Event('error'))
    return
  }
  const s = new SpeechSynthesisUtterance(u.text)
  s.rate = u.rate
  const voice = fallbackBrowserVoice(u.voice.lang)
  if (voice) s.voice = voice
  s.onstart = () => {
    if (token === playToken) u.onstart?.()
  }
  s.onend = () => {
    fallbackSpeaking = false
    if (token === playToken) u.onend?.()
  }
  s.onerror = (e) => {
    fallbackSpeaking = false
    if (token !== playToken || e.error === 'interrupted' || e.error === 'canceled') return
    u.onerror?.(e)
  }
  fallbackSpeaking = true
  if (synth.speaking || synth.pending) {
    // Chromium clips an utterance spoken in the same tick as cancel().
    synth.cancel()
    setTimeout(() => {
      if (token === playToken) synth.speak(s)
    }, 10)
  } else {
    synth.speak(s)
  }
}

/** Play a CloudUtterance, replacing whatever Google clip was playing. */
export function speakCloud(u: CloudUtterance): void {
  const token = ++playToken
  stopAudio()
  if (fallbackSpeaking) {
    fallbackSpeaking = false
    window.speechSynthesis?.cancel()
  }
  // With the quota used up, getClip still serves cached clips and rejects the
  // rest without asking the server.
  getClip(u.text, u.voice)
    .then((blob) => {
      if (token !== playToken) return
      const el = audio()
      currentUrl = URL.createObjectURL(blob)
      el.src = currentUrl
      // A new src resets playbackRate to defaultPlaybackRate, so set both.
      el.defaultPlaybackRate = u.rate
      el.playbackRate = u.rate
      el.onended = () => {
        if (token !== playToken) return
        stopAudio()
        u.onend?.()
      }
      el.onerror = () => {
        if (token !== playToken) return
        stopAudio()
        speakFallback(u, token)
      }
      el.play()
        .then(() => {
          if (token === playToken) u.onstart?.()
        })
        .catch((err: unknown) => {
          // AbortError: a newer play() or pause() took over, nothing to do.
          if (token !== playToken || (err as Error)?.name === 'AbortError') return
          stopAudio()
          speakFallback(u, token)
        })
    })
    .catch((err: unknown) => {
      if (token !== playToken) return
      if (err instanceof QuotaError) {
        markExhausted(err.tier, err.period)
        // Another Google family may still have quota: same voices everywhere
        // beats the browser's, so try that before falling back.
        const alt = alternateGoogleVoice(u.voice, exhausted)
        notify({ kind: 'quota', tier: err.tier, period: err.period, fallback: alt?.tier ?? 'browser' })
        if (alt) {
          u.voice = alt
          speakCloud(u)
          return
        }
      } else {
        notify({ kind: 'error' })
      }
      speakFallback(u, token)
    })
}

/** Stop any Google clip (and the browser voice standing in for one). */
export function cancelCloud(): void {
  playToken++
  stopAudio()
  if (fallbackSpeaking) {
    fallbackSpeaking = false
    window.speechSynthesis?.cancel()
  }
}

/** Stop all speech, Google and browser alike. */
export function cancelSpeech(): void {
  cancelCloud()
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
}

// iOS Safari only lets an <audio> element play without a tap once it has
// played inside one. Clips are fetched first and so start outside the tap, so
// the shared element is unlocked on the first interaction with the page.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA'
function unlockAudio() {
  window.removeEventListener('pointerdown', unlockAudio, true)
  window.removeEventListener('keydown', unlockAudio, true)
  if (currentUrl) return // already playing a clip
  const el = audio()
  el.src = SILENT_WAV
  el.play().catch(() => {})
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAudio, true)
  window.addEventListener('keydown', unlockAudio, true)
}
