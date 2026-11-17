import { useEffect, useState } from 'react'
import { api } from './api'

// The voices the app reads with, shared by Workspace (playback), Practice and
// Settings (the voice picker) so all three see the same list.
//
// Two sources:
//   - Google Cloud Text-to-Speech (Chirp 3 HD and Neural2), synthesized by the
//     backend — the same voices on every browser and phone. Present when the
//     server has it enabled (/api/tts/status).
//   - The browser's own speechSynthesis voices. On Edge only its "Online
//     (Natural)" voices are kept; Edge's older robotic voices are dropped.
//     Other browsers contribute nothing while Google voices exist.
// With no Google voices and no Edge Natural voices (desktop app, server without
// TTS) the old browser fallback chain applies, so speech still works.
//
// Names are what settings store; `source` says which engine plays a voice.

export type GoogleTier = 'chirp3hd' | 'neural2'

export interface AppVoice {
  name: string
  label: string
  lang: string
  source: 'google' | 'browser'
  tier?: GoogleTier
  /** The engine voice, for source 'browser'. */
  browserVoice?: SpeechSynthesisVoice
}

export const TIER_LABELS: Record<GoogleTier, string> = {
  chirp3hd: 'Google Chirp 3 HD',
  neural2: 'Google Neural2',
}

// --- browser voices -----------------------------------------------------------

const isEdgeNatural = (v: SpeechSynthesisVoice) => /online\s*\(natural\)/i.test(v.name)
const isEnglish = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith('en')

// The pre-Google fallback: premium/enhanced voices (Chromium "Google … (Premium)",
// Safari "… (Enhanced)"), else any English voice (Safari's default set has no
// premium marker), else everything the browser offers.
function fallbackBrowserVoices(all: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const premium = all.filter((v) => {
    const n = v.name.toLowerCase()
    return n.includes('premium') || n.includes('enhanced')
  })
  const english = all.filter(isEnglish)
  return premium.length ? premium : english.length ? english : all
}

function selectBrowserVoices(all: SpeechSynthesisVoice[], haveGoogle: boolean): SpeechSynthesisVoice[] {
  const natural = all.filter((v) => isEdgeNatural(v) && isEnglish(v))
  if (natural.length) return natural
  if (haveGoogle) return []
  return fallbackBrowserVoices(all)
}

/**
 * Short display name for a browser voice, e.g.
 * "Microsoft BrianMultilingual Online (Natural) - English (United States)"
 * becomes "Brian Multilingual (Natural)". Store and match by voice.name.
 */
function browserVoiceLabel(voice: SpeechSynthesisVoice): string {
  const short = voice.name
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s+Online\b/i, '')
    // The language part; voice.lang says the same in fewer letters.
    .replace(/\s+-\s+.*$/, '')
    .replace(/([a-z])(Multilingual)\b/, '$1 $2')
    .trim()
  return short || voice.name
}

/** Picker text: "Aoede (en-US)". */
export function voiceLabel(voice: AppVoice): string {
  return voice.lang ? `${voice.label} (${voice.lang})` : voice.label
}

/** Picker group heading. */
export function voiceGroup(voice: AppVoice): string {
  if (voice.source === 'google') return TIER_LABELS[voice.tier ?? 'chirp3hd']
  return isEdgeNatural(voice.browserVoice!) ? 'Edge Natural' : 'Browser'
}

// --- shared cache -------------------------------------------------------------
//
// Loading happens once at module level rather than per hook: `onvoiceschanged`
// is a single slot, so components each assigning their own handler meant only
// the last one mounted heard it. addEventListener + a shared cache fixes that.

let browserAll: SpeechSynthesisVoice[] = []
let googleVoices: AppVoice[] = []
let googleDefault: string | null = null
let combined: AppVoice[] = []
const subscribers = new Set<(voices: AppVoice[]) => void>()

function rebuild() {
  const browser = selectBrowserVoices(browserAll, googleVoices.length > 0)
    .map<AppVoice>((v) => ({
      name: v.name,
      label: browserVoiceLabel(v),
      lang: v.lang,
      source: 'browser',
      browserVoice: v,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  combined = [...googleVoices, ...browser]
  subscribers.forEach((fn) => fn(combined))
}

let listening = false

function refreshBrowserVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const all = window.speechSynthesis.getVoices()
  if (!all.length) return
  browserAll = all
  rebuild()
}

function startBrowserVoices() {
  if (listening || typeof window === 'undefined' || !window.speechSynthesis) return
  listening = true
  window.speechSynthesis.addEventListener('voiceschanged', refreshBrowserVoices)
  refreshBrowserVoices()
  // Chrome does not always fire `voiceschanged` (notably on a reload where the
  // voice list is already warm), so poll briefly as a backstop.
  let tries = 0
  const poll = setInterval(() => {
    refreshBrowserVoices()
    if (browserAll.length || ++tries > 20) clearInterval(poll)
  }, 250)
}

export interface TtsUsage {
  used: number
  limit: number
}

export interface TtsStatus {
  enabled: boolean
  default_voice?: string
  usage?: Record<GoogleTier, TtsUsage>
}

export function fetchTtsStatus(): Promise<TtsStatus> {
  return api.get<TtsStatus>('/api/tts/status').then((r) => r.data)
}

// Loaded once per page load; a failure (server down, Google unreachable) is
// forgotten so the next mounted hook tries again.
let googleLoad: Promise<void> | null = null

function loadGoogleVoices() {
  if (googleLoad) return
  googleLoad = (async () => {
    const status = await fetchTtsStatus()
    if (!status.enabled) return
    const { data } = await api.get<Omit<AppVoice, 'source'>[]>('/api/tts/voices')
    googleDefault = status.default_voice ?? null
    googleVoices = data.map((v) => ({ ...v, source: 'google' }))
    rebuild()
  })().catch(() => {
    googleLoad = null
  })
}

/** Every voice the user can pick, Google first. */
export function useAvailableVoices(): AppVoice[] {
  const [voices, setVoices] = useState<AppVoice[]>(combined)

  useEffect(() => {
    subscribers.add(setVoices)
    startBrowserVoices()
    loadGoogleVoices()
    setVoices(combined)
    return () => {
      subscribers.delete(setVoices)
    }
  }, [])

  return voices
}

/**
 * The voice used when none is picked, or the picked one is not offered here
 * (e.g. a browser voice saved on another machine): the server's default Google
 * voice when there is one, otherwise null — the browser's own default.
 */
export function defaultVoice(voices: readonly AppVoice[]): AppVoice | null {
  return (
    (googleDefault ? voices.find((v) => v.name === googleDefault) : undefined) ??
    voices.find((v) => v.source === 'google') ??
    // Edge without Google: its own default would be one of the robotic voices.
    voices.find((v) => v.browserVoice && isEdgeNatural(v.browserVoice)) ??
    null
  )
}

/** The picked voice if it is available, else defaultVoice. */
export function resolveVoice(name: string, voices: readonly AppVoice[]): AppVoice | null {
  return (name && voices.find((v) => v.name === name)) || defaultVoice(voices)
}

/**
 * Another Google voice to stand in for `voice` when its family's quota is used
 * up: one from a family not in `exhausted`, same language if possible.
 */
export function alternateGoogleVoice(voice: AppVoice, exhausted: { has(tier: GoogleTier): boolean }): AppVoice | null {
  const usable = googleVoices.filter((v) => v.tier && v.tier !== voice.tier && !exhausted.has(v.tier))
  return usable.find((v) => v.lang === voice.lang) ?? usable[0] ?? null
}

/**
 * A browser voice to read with when a Google clip cannot be had (quota used up,
 * network error): Edge Natural if offered, else whatever the fallback chain picks.
 */
export function fallbackBrowserVoice(lang?: string): SpeechSynthesisVoice | null {
  const natural = browserAll.filter((v) => isEdgeNatural(v) && isEnglish(v))
  const pool = natural.length ? natural : fallbackBrowserVoices(browserAll)
  return pool.find((v) => lang && v.lang === lang) ?? pool[0] ?? null
}

// Cloud ("network") browser voices are synthesized on a remote server, so every
// utterance costs an HTTPS round-trip before any audio plays — Edge's
// "… Online (Natural)" family is the common case. Callers use this to drop the
// warm-up primer (a wasted second round-trip) and to compensate the
// word-by-word gap for the delay. Google voices are fetched as files and
// prefetched, so they are not counted here.
//
// localService is the spec-provided signal, but not every engine reports it
// correctly, so Edge's naming convention is matched as a backstop.
export function isNetworkVoice(voice: SpeechSynthesisVoice | null | undefined): boolean {
  if (!voice) return false
  if (voice.localService === false) return true
  return isEdgeNatural(voice)
}

// Rolling estimate of how long a voice takes between speak() and onstart, kept
// per voice name. Word-by-word playback subtracts this from the gap it waits so
// the silence the learner hears is the gap they configured, not gap + latency.
const latencyByVoice = new Map<string, number>()

// Never let a freak measurement (a stalled request, a backgrounded tab) eat the
// whole gap; compensation is capped well below any usable Word Gap.
const MAX_TRACKED_LATENCY_MS = 1500

export function recordVoiceLatency(voiceName: string, ms: number): void {
  if (!voiceName || !Number.isFinite(ms) || ms < 0) return
  const sample = Math.min(ms, MAX_TRACKED_LATENCY_MS)
  const prev = latencyByVoice.get(voiceName)
  // Exponential moving average: smooths jitter but still tracks a network that
  // gets slower or faster part-way through a lesson.
  latencyByVoice.set(voiceName, prev === undefined ? sample : prev * 0.7 + sample * 0.3)
}

export function estimatedVoiceLatency(voiceName: string | undefined | null): number {
  if (!voiceName) return 0
  return latencyByVoice.get(voiceName) ?? 0
}

// Chrome silently stops synthesis roughly 15 seconds into a single utterance.
// Nudging it with pause()/resume() on a timer keeps long sentences audible.
// Harmless on Safari/Electron, which don't have the bug.
export function startSpeechKeepAlive(): () => void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return () => {}
  const synth = window.speechSynthesis
  const timer = setInterval(() => {
    if (synth.speaking && !synth.paused) {
      synth.pause()
      synth.resume()
    }
  }, 10000)
  return () => clearInterval(timer)
}
