// Multi-voice playback: rotating through 2-4 voices instead of reading
// everything in one, so the learner's ear does not settle into a single speaker.
//
// Shared by Workspace (useTtsPlayback) and Practice, which have separate
// speech paths but must agree on which voice speaks what — otherwise the same
// settings would produce different playback on the two screens.

export type VoiceOrder = 'fixed' | 'random'

/** A pool below this is indistinguishable from single-voice playback. */
export const MIN_VOICE_POOL = 2
/** Past this the voices stop being tellable apart within one sentence. */
export const MAX_VOICE_POOL = 4

/**
 * Map saved voice names onto the voices this browser actually offers.
 *
 * Names are stored, not voice objects, so a pool saved on another machine (or
 * before an OS voice pack was removed) can name voices that no longer exist.
 * Those are dropped rather than treated as an error.
 */
export function resolveVoicePool(
  names: readonly string[],
  availableVoices: readonly SpeechSynthesisVoice[]
): SpeechSynthesisVoice[] {
  if (!names.length || !availableVoices.length) return []
  const byName = new Map(availableVoices.map((v) => [v.name, v]))
  const resolved: SpeechSynthesisVoice[] = []
  for (const name of names) {
    const voice = byName.get(name)
    // Guard against a duplicate name in storage claiming two slots
    if (voice && !resolved.includes(voice)) resolved.push(voice)
  }
  return resolved
}

/** FNV-1a. Any stable string->int would do; this one is short and has no deps. */
function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Order the pool for one sentence.
 *
 * `random` is seeded from the sentence, deliberately: every repeat of a
 * sentence re-runs the playback effect and re-derives the order, so a truly
 * random shuffle would deal a different order on each repeat and the rotation would
 * revisit the same voice instead of cycling. Seeding makes the order stable
 * within a sentence and different between sentences, which is what "shuffle
 * per sentence" should mean.
 */
export function orderPoolForSentence(
  pool: readonly SpeechSynthesisVoice[],
  order: VoiceOrder,
  sentenceKey: string
): SpeechSynthesisVoice[] {
  if (order === 'fixed' || pool.length < 2) return [...pool]

  // Fisher-Yates driven by a seeded LCG so the shuffle is reproducible.
  const shuffled = [...pool]
  let seed = hashString(sentenceKey) || 1
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const j = seed % (i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/**
 * Draw `count` voices at random from what the browser offers, for the
 * "Randomize" button in Settings.
 *
 * Deliberately unseeded, unlike orderPoolForSentence: pressing the button is a
 * request for a fresh draw, not for something reproducible. The returned order
 * is part of the draw — with only as many voices installed as the pool holds,
 * re-drawing still changes the order playback rotates through.
 */
export function pickRandomVoices(
  available: readonly SpeechSynthesisVoice[],
  count: number
): string[] {
  const wanted = Math.max(MIN_VOICE_POOL, Math.min(MAX_VOICE_POOL, Math.floor(count) || 0))
  const shuffled = [...available]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, Math.min(wanted, shuffled.length)).map((v) => v.name)
}

/**
 * The voice for the nth reading, wrapping around the pool. The reading may be a
 * sentence repeat or a word repeat inside word-by-word mode; callers add those
 * two steps together so both can advance the rotation at once.
 */
export function voiceForRepeat(
  pool: readonly SpeechSynthesisVoice[],
  repeatIndex: number
): SpeechSynthesisVoice | null {
  if (!pool.length) return null
  const safeIndex = Number.isFinite(repeatIndex) && repeatIndex > 0 ? Math.floor(repeatIndex) : 0
  return pool[safeIndex % pool.length]
}
