import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { useWorkspace, type Sentence } from '../../contexts/WorkspaceContext'

export type SeekTo = (time: number, options?: { play?: boolean }) => void

/** How far the player may land from where it was sent before it is sent again */
const SEEK_TOLERANCE_S = 0.25
/** Played past a sentence's own end, so its last sound is not clipped */
const SENTENCE_TAIL_S = 0.15

/**
 * Where playback of sentence `index` stops: shortly after its last word, and
 * never later than the start of the next sentence.
 */
export function sentenceStopTime(sentences: Sentence[], index: number, totalDuration: number): number {
  const sentence = sentences[index]
  const next = sentences[index + 1]
  const hardStop = next ? next.start_time : totalDuration
  if (!sentence || !(sentence.end_time > sentence.start_time)) return hardStop
  const ownStop = sentence.end_time + SENTENCE_TAIL_S
  return hardStop > 0 ? Math.min(hardStop, ownStop) : ownStop
}

interface UseAudioPlaybackParams {
  /** False while the lesson's audio has not been fetched yet: nothing may play */
  audioReady: boolean
  /** The source on the <audio> element; each new one makes the browser reload it */
  audioBlobUrl: string | null
  audioRef: MutableRefObject<HTMLAudioElement | null>
  intervalTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  isWaitingForPauseIntervalRef: MutableRefObject<boolean>
  repeatCountRef: MutableRefObject<number>
  programmaticSeekRef: MutableRefObject<boolean>
  userInitiatedSentenceChangeRef: MutableRefObject<boolean>
  sentenceIndexFromPlaybackRef: MutableRefObject<boolean>
  skipNextSentenceResetRef: MutableRefObject<boolean>
  prevSentencesIdentityRef: MutableRefObject<string | null>
  /** Mirror of isCurrentSentenceFullyCorrect, read inside the advance interval */
  isCurrentSentenceFullyCorrectRef: MutableRefObject<boolean>
}

/**
 * Drives the <audio> element for non-text lessons: playback rate, progress
 * sync, sentence-by-sentence advance with repeat/pause-interval, seeking on
 * sentence change, and play/pause. Text (TTS) lessons are handled by
 * useTtsPlayback and are skipped here.
 */
export function useAudioPlayback({
  audioReady,
  audioBlobUrl,
  audioRef,
  intervalTimeoutRef,
  isWaitingForPauseIntervalRef,
  repeatCountRef,
  programmaticSeekRef,
  userInitiatedSentenceChangeRef,
  sentenceIndexFromPlaybackRef,
  skipNextSentenceResetRef,
  prevSentencesIdentityRef,
  isCurrentSentenceFullyCorrectRef,
}: UseAudioPlaybackParams) {
  const {
    selectedLesson,
    sentences,
    sentencesVideoId,
    currentSentenceIndex,
    setCurrentSentenceIndex,
    isPlaying,
    setIsPlaying,
    currentTime,
    setCurrentTime,
    playbackSpeed,
    pauseInterval,
    repeatCount,
    wordInputs,
    ignoreCase,
    ignorePunctuation,
  } = useWorkspace()

  // The one way to move the playhead. Browsers differ in what they do with a
  // seek made before the audio has loaded or while another seek is running, so
  // this waits for the audio, checks where it landed, and sends it again if
  // that is not where it was told to go. A newer seek cancels an older one.
  const seekGenerationRef = useRef(0)
  // Read when a seek lands: Next, Replay and their shortcuts all seek with
  // play, and must not start an element still holding no (or the last
  // lesson's) audio.
  const audioReadyRef = useRef(audioReady)
  audioReadyRef.current = audioReady
  const seekTo = useCallback<SeekTo>((time, options) => {
    const audio = audioRef.current
    setCurrentTime(time)
    if (!audio) return
    const generation = ++seekGenerationRef.current
    const isCurrent = () => generation === seekGenerationRef.current && audioRef.current === audio

    const apply = (retriesLeft: number, mayPlay = true) => {
      if (!isCurrent()) return
      let settled = false
      const onSettled = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        audio.removeEventListener('seeked', onSettled)
        if (!isCurrent()) return
        // While playing, the playhead has moved on a little since the seek.
        const drift = audio.currentTime - time
        if (retriesLeft > 0 && (drift < -SEEK_TOLERANCE_S || drift > SEEK_TOLERANCE_S + 0.5)) {
          apply(retriesLeft - 1)
        }
      }
      audio.addEventListener('seeked', onSettled)
      const timer = setTimeout(onSettled, 500)
      audio.currentTime = time
      // Still inside the tap or key press that asked for it, which phones
      // require before they let audio start.
      if (mayPlay && options?.play && audioReadyRef.current) audio.play().catch(() => { })
    }

    if (audio.readyState < 1) {
      // No metadata yet. Setting currentTime now makes it the position playback
      // starts from once the media loads (HTML "default playback start
      // position"); Safari on iPhone loads nothing before play(), and play()
      // must happen now, inside the tap, or iOS refuses it. Once the audio is
      // known, the seek is checked and sent again if it did not hold.
      try {
        audio.currentTime = time
      } catch {
        // some browsers throw before metadata; the check below still seeks
      }
      if (options?.play && audioReadyRef.current) audio.play().catch(() => { })
      audio.addEventListener('loadedmetadata', () => apply(1, false), { once: true })
      return
    }
    apply(1)
  }, [audioRef, setCurrentTime])

  // Speed: set on the element and as its default, which (unlike playbackRate)
  // survives the reload every new source triggers. Without it a lesson came
  // back from Settings or a reload at 1x while the menu still said 0.6x.
  useEffect(() => {
    if (selectedLesson?.youtube_url?.startsWith('text://')) return
    const audio = audioRef.current
    if (!audio) return
    const apply = () => {
      audio.defaultPlaybackRate = playbackSpeed
      audio.playbackRate = playbackSpeed
    }
    apply()
    audio.addEventListener('loadedmetadata', apply)
    return () => audio.removeEventListener('loadedmetadata', apply)
  }, [playbackSpeed, selectedLesson, audioBlobUrl])

  // A new source (the lesson's audio arriving, also after coming back from
  // another page) loads from 0: put the playhead back on the sentence shown,
  // where it was if that is inside the sentence, else at its start.
  const latestRef = useRef({ sentences, currentSentenceIndex, currentTime, duration: selectedLesson?.duration ?? 0 })
  latestRef.current = { sentences, currentSentenceIndex, currentTime, duration: selectedLesson?.duration ?? 0 }
  useEffect(() => {
    if (!audioBlobUrl) return
    const { sentences: list, currentSentenceIndex: index, currentTime: saved, duration } = latestRef.current
    const sentence = list[index]
    if (!sentence) return
    const stop = sentenceStopTime(list, index, duration)
    const inside = saved >= sentence.start_time && (stop <= 0 || saved < stop - 0.05)
    seekTo(inside ? saved : sentence.start_time)
  }, [audioBlobUrl, seekTo])

  // Handle time updates: keep progress bar (currentTime) in sync with audio playback
  useEffect(() => {
    if (selectedLesson?.youtube_url?.startsWith('text://')) return
    const audio = audioRef.current
    if (!audio || !sentences.length) return

    const updateTime = () => {
      const t = audio.currentTime
      setCurrentTime(t)
    }

    audio.addEventListener('timeupdate', updateTime)
    return () => audio.removeEventListener('timeupdate', updateTime)
  }, [sentences, selectedLesson])

  // Handle sentence-by-sentence playback
  useEffect(() => {
    if (selectedLesson?.youtube_url?.startsWith('text://')) return
    const audio = audioRef.current
    if (!audio || !sentences.length || !isPlaying) return

    const currentSentence = sentences[currentSentenceIndex]
    if (!currentSentence) return

    const totalDuration = selectedLesson?.duration ?? 0

    const checkSentenceEnd = () => {
      if (!isPlaying) return

      const endTime = sentenceStopTime(sentences, currentSentenceIndex, totalDuration)

      if (!endTime || endTime <= 0) return

      const hasReachedEnd = audio.currentTime >= endTime - 0.01
      if (!hasReachedEnd) return

      // When repeat is ∞, only advance when the user has spelled the current sentence fully correctly
      const shouldRepeat =
        repeatCount === '∞'
          ? !isCurrentSentenceFullyCorrectRef.current
          : (typeof repeatCount === 'number' && repeatCountRef.current <= repeatCount - 1)

      if (pauseInterval > 0) {
        // Simulate "click pause" at start: UI and audio show paused
        isWaitingForPauseIntervalRef.current = true
        if (intervalTimeoutRef.current) clearTimeout(intervalTimeoutRef.current)
        intervalTimeoutRef.current = setTimeout(() => {
          isWaitingForPauseIntervalRef.current = false
          intervalTimeoutRef.current = null
          const audioEl = audioRef.current
          if (!audioEl) return
          const playAfterSeek = (targetTime: number) => {
            programmaticSeekRef.current = true
            setIsPlaying(true)
            seekTo(targetTime, { play: true })
          }
          if (shouldRepeat) {
            repeatCountRef.current++
            if (currentSentence) {
              playAfterSeek(currentSentence.start_time)
            } else {
              setIsPlaying(true)
            }
          } else {
            repeatCountRef.current = 0
            if (currentSentenceIndex < sentences.length - 1) {
              const nextIndex = currentSentenceIndex + 1
              setCurrentSentenceIndex(nextIndex)
              const ns = sentences[nextIndex]
              if (ns) {
                playAfterSeek(ns.start_time)
                userInitiatedSentenceChangeRef.current = true
              } else {
                setIsPlaying(true)
              }
            } else {
              setCurrentSentenceIndex(0)
              seekTo(0)
            }
          }
        }, pauseInterval * 1000)
        setIsPlaying(false) // simulate "click pause"
      } else {
        if (shouldRepeat) {
          repeatCountRef.current++
          if (audioRef.current && currentSentence) {
            programmaticSeekRef.current = true
            seekTo(currentSentence.start_time, { play: true })
          }
        } else {
          repeatCountRef.current = 0
          const audioEl = audioRef.current
          if (!audioEl) return
          if (currentSentenceIndex < sentences.length - 1) {
            const nextIndex = currentSentenceIndex + 1
            setCurrentSentenceIndex(nextIndex)
            const ns = sentences[nextIndex]
            if (ns) {
              programmaticSeekRef.current = true
              seekTo(ns.start_time, { play: true })
            }
          } else {
            setIsPlaying(false)
            setCurrentSentenceIndex(0)
            audioEl.pause()
            seekTo(0)
          }
        }
      }
    }

    const intervalId = setInterval(checkSentenceEnd, 20) // Check more frequently for better accuracy
    return () => {
      clearInterval(intervalId)
      if (intervalTimeoutRef.current && !isWaitingForPauseIntervalRef.current) {
        clearTimeout(intervalTimeoutRef.current)
        intervalTimeoutRef.current = null
      }
    }
  }, [currentSentenceIndex, sentences, isPlaying, pauseInterval, repeatCount, selectedLesson?.duration, wordInputs, ignoreCase, ignorePunctuation])

  // Keep audio progress in sync with current subtitle: seek to current sentence's start_time when subtitle changes.
  useEffect(() => {
    if (!audioRef.current || !sentences.length) return
    const sentence = sentences[currentSentenceIndex]
    if (!sentence) return
    if (programmaticSeekRef.current) {
      programmaticSeekRef.current = false
      return
    }
    if (userInitiatedSentenceChangeRef.current) {
      userInitiatedSentenceChangeRef.current = false
      return
    }
    if (sentenceIndexFromPlaybackRef.current) {
      sentenceIndexFromPlaybackRef.current = false
      return
    }
    seekTo(sentence.start_time)
  }, [currentSentenceIndex, sentences])

  // Reset to sentence 0 only when sentences actually change (e.g. new lesson). Do not reset on remount or Strict Mode double-invocation.
  useEffect(() => {
    if (sentences.length === 0) return
    const identity = `${sentencesVideoId ?? ''}-${sentences.length}-${sentences[0]?.id ?? ''}`
    if (prevSentencesIdentityRef.current === identity) return
    const isNewSentences = prevSentencesIdentityRef.current !== null
    prevSentencesIdentityRef.current = identity
    if (skipNextSentenceResetRef.current) {
      skipNextSentenceResetRef.current = false
      return
    }
    if (isNewSentences && !isPlaying) {
      setCurrentSentenceIndex(0)
      repeatCountRef.current = 0
      seekTo(sentences[0].start_time)
    }
  }, [sentences, sentencesVideoId, isPlaying])

  // Handle play/pause
  useEffect(() => {
    if (selectedLesson?.youtube_url?.startsWith('text://')) return
    const audio = audioRef.current
    if (!audio || !sentences.length) return

    if (isPlaying && audioReady) {
      if (intervalTimeoutRef.current) {
        clearTimeout(intervalTimeoutRef.current)
        intervalTimeoutRef.current = null
      }
      isWaitingForPauseIntervalRef.current = false
      if (programmaticSeekRef.current) {
        programmaticSeekRef.current = false
        audio.play().catch(() => { })
        return
      }
      const currentSentence = sentences[currentSentenceIndex]
      if (currentSentence) {
        // Play what is on screen: if the playhead is anywhere outside the
        // current sentence, before it or after it, start the sentence over.
        const stopTime = sentenceStopTime(sentences, currentSentenceIndex, selectedLesson?.duration ?? 0)
        const t = audio.currentTime
        // Without metadata the element reports 0 whatever was asked of it:
        // seek, so playback cannot start from the top of the lesson.
        const outside =
          audio.readyState < 1 ||
          t < currentSentence.start_time - 0.05 ||
          (stopTime > 0 && t >= stopTime - 0.05)
        if (outside) {
          seekTo(currentSentence.start_time, { play: true })
        } else {
          audio.play().catch(() => { })
        }
      }
    } else {
      audio.pause()
    }
  }, [isPlaying, audioReady, currentSentenceIndex, sentences, selectedLesson])

  return { seekTo }
}
