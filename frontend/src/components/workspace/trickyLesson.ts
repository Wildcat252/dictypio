import { getTrickySentences } from '../../api'
import type { Lesson, Sentence } from '../../contexts/WorkspaceContext'

/**
 * "Tricky sentences" is a virtual lesson: the most recent sentence each
 * tricky word (hinted twice) was struggled in, gathered across all lessons.
 * It has no video of its own, so it uses a sentinel id and is played by TTS.
 */
export const TRICKY_LESSON_ID = -1

export function isTrickyLesson(lesson: Pick<Lesson, 'video_id'> | null | undefined): boolean {
  return lesson?.video_id === TRICKY_LESSON_ID
}

export function makeTrickyLesson(sentenceCount: number): Lesson {
  return {
    id: TRICKY_LESSON_ID,
    video_id: TRICKY_LESSON_ID,
    title: 'Tricky sentences',
    duration: 0,
    sentence_count: sentenceCount,
    // Played by speech synthesis like a pasted-text lesson
    youtube_url: 'text://tricky',
  }
}

/** Sentence id -> the real video it belongs to, so progress lands on the source lesson. */
const videoOfSentence = new Map<number, number>()

export function trickySentenceVideoId(sentenceId: number): number | undefined {
  return videoOfSentence.get(sentenceId)
}

/** Fetch tricky sentences as lesson sentences (one per source sentence). */
export async function fetchTrickySentences(): Promise<Sentence[]> {
  const rows = await getTrickySentences()
  const seen = new Set<number>()
  const out: Sentence[] = []
  for (const row of rows) {
    // Several tricky words can share one sentence; drill it once
    if (seen.has(row.sentence_id)) continue
    seen.add(row.sentence_id)
    videoOfSentence.set(row.sentence_id, row.video_id)
    out.push({
      id: row.sentence_id,
      // Transcripts keep their line breaks; nobody types those
      sentence_text: row.sentence.replace(/\s+/g, ' ').trim(),
      // Text lessons use the sentence index as their timeline
      start_time: out.length,
      end_time: out.length + 1,
      sentence_index: out.length,
    })
  }
  return out
}
