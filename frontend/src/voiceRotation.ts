// Multi-voice playback: reading a sentence with 2-4 voices instead of one, so
// the learner's ear does not settle into a single speaker.
//
// Shared by Workspace (useTtsPlayback) and Practice, which have separate
// speech paths but must agree on which voice speaks what — otherwise the same
// settings would produce different playback on the two screens.

export type MultiVoiceMode = 'repeat' | 'split'
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

/** The voice for the nth reading of a sentence, wrapping around the pool. */
export function voiceForRepeat(
  pool: readonly SpeechSynthesisVoice[],
  repeatIndex: number
): SpeechSynthesisVoice | null {
  if (!pool.length) return null
  const safeIndex = Number.isFinite(repeatIndex) && repeatIndex > 0 ? Math.floor(repeatIndex) : 0
  return pool[safeIndex % pool.length]
}

/**
 * Split a sentence into `parts` contiguous chunks on word boundaries, so each
 * chunk can be handed to a different voice.
 *
 * Chunks are cut at a comma/semicolon/colon where one falls near the ideal
 * boundary, because a handover mid-clause sounds like a glitch while one at a
 * comma sounds like two speakers taking turns.
 *
 * The concatenation of the result (joined with a single space) always contains
 * every word of the input exactly once — no word is dropped or repeated.
 */
export function splitTextForVoices(text: string, parts: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (parts <= 1 || words.length <= 1) return words.length ? [words.join(' ')] : []

  // More voices than words: give each word its own chunk and stop there.
  const chunkCount = Math.min(parts, words.length)
  const endsClause = (word: string) => /[,;:]$/.test(word)

  const chunks: string[] = []
  let start = 0
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    const remainingChunks = chunkCount - chunk
    if (remainingChunks === 1) {
      chunks.push(words.slice(start).join(' '))
      break
    }

    const chunkLength = (words.length - start) / remainingChunks
    const ideal = start + Math.round(chunkLength)
    // Keep at least one word here and one for every chunk still to come.
    const min = start + 1
    const max = words.length - (remainingChunks - 1)
    let end = Math.min(Math.max(ideal, min), max)

    // Prefer a clause boundary near the ideal cut, closest one first: a handover
    // mid-clause sounds like a glitch, one at a comma sounds like taking turns.
    // The window scales with chunk length but stays wide enough to reach an
    // early comma in a short sentence ("Hello, | how are you today?").
    const window = Math.max(2, Math.round(chunkLength * 0.5))
    for (let distance = 0; distance <= window; distance++) {
      const candidates = distance === 0 ? [end] : [end - distance, end + distance]
      const hit = candidates.find(
        (c) => c >= min && c <= max && endsClause(words[c - 1])
      )
      if (hit !== undefined) {
        end = hit
        break
      }
    }

    chunks.push(words.slice(start, end).join(' '))
    start = end
  }

  return chunks
}

/**
 * Which chunk a word index belongs to, given the chunk sizes produced by
 * `splitTextForVoices`. Word-by-word playback needs this to pick a voice per
 * spoken token while keeping the same handover points as whole-sentence mode.
 */
export function chunkIndexForWord(chunks: readonly string[], wordIndex: number): number {
  let seen = 0
  for (let i = 0; i < chunks.length; i++) {
    seen += chunks[i] ? chunks[i].split(/\s+/).filter(Boolean).length : 0
    if (wordIndex < seen) return i
  }
  return Math.max(0, chunks.length - 1)
}
