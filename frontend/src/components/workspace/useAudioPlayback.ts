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
  const seekTo = useCallback<SeekTo>((time, options) => {
    const audio = audioRef.current
    setCurrentTime(time)
    if (!audio) return
    const generation = ++seekGenerationRef.current
    const isCurrent = () => generation === seekGenerationRef.current && audioRef.current === audio

    const apply = (retriesLeft: number) => {
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
      if (options?.play) audio.play().catch(() => { })
    }

    if (audio.readyState < 1) {
      // No metadata yet: the seek would be dropped. Do it once the audio is known.
      audio.addEventListener('loadedmetadata', () => apply(1), { once: true })
      return
    }
    apply(1)
  }, [audioRef, setCurrentTime])

  // Update audio playback speed when speed changes
  useEffect(() => {
    if (selectedLesson?.youtube_url?.startsWith('text://')) return
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed
    }
  }, [playbackSpeed, selectedLesson])

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

    if (isPlaying) {
      if (intervalTimeoutRef.current) {
        clearTimeout(intervalTimeoutRef.current)
        intervalTimeoutRef.current = null
      }
      isWaitingForPauseIntervalRef.current = false
      if (programmaticSeekRef.current) {
        programmaticSeekRef.current = false
        audio.play()
        return
      }
      const currentSentence = sentences[currentSentenceIndex]
      if (currentSentence) {
        // Play what is on screen: if the playhead is anywhere outside the
        // current sentence, before it or after it, start the sentence over.
        const stopTime = sentenceStopTime(sentences, currentSentenceIndex, selectedLesson?.duration ?? 0)
        const t = audio.currentTime
        const outside = t < currentSentence.start_time - 0.05 || (stopTime > 0 && t >= stopTime - 0.05)
        if (outside) {
          seekTo(currentSentence.start_time, { play: true })
        } else {
          audio.play().catch(() => { })
        }
      }
    } else {
      audio.pause()
    }
  }, [isPlaying, currentSentenceIndex, sentences, selectedLesson])

  return { seekTo }
}
