import { useState, useEffect, useRef, useCallback } from 'react'
import { AppHeader } from './AppHeader'
import {
  api,
  upsertCurrentLessonSession,
  saveLessonSession,
  translateText,
  getLessonSessions,
  type LessonSessionRecord,
} from '../api'
import { useWorkspace, type Lesson } from '../contexts/WorkspaceContext'
import { loadKeybindings, displayKey } from '../keybindings'
import { loadAudioSettings, playCelebrationChime } from '../audio'
import { usePremiumVoices } from '../voices'
import { useTtsPlayback } from './workspace/useTtsPlayback'
import { isTrickyLesson, trickySentenceVideoId } from './workspace/trickyLesson'
import { useWorkspaceShortcuts } from './workspace/useWorkspaceShortcuts'
import { useAudioPlayback } from './workspace/useAudioPlayback'
import { useLessonData } from './workspace/useLessonData'
import { CoachDrawer, type CoachDrawerHandle } from './workspace/CoachDrawer'
import { AI_COACH_ENABLED } from '../features'
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar'
import { DictationArea } from './workspace/DictationArea'
import { PlayerPanel } from './workspace/PlayerPanel'
import ImportModal from './ImportModal'
import LessonHistory from './LessonHistory'

const SPEED_OPTIONS = [0.2, 0.4, 0.6, 0.8, 1, 1.2]

// A single sentence never contributes more than this to the typing clock, so
// walking away mid-sentence cannot wreck the WPM figure.
const MAX_SENTENCE_TYPING_MS = 120_000
// A pause longer than this between keystrokes counts as "stopped typing"
// rather than "waiting for the next word to be spoken".
const TYPING_IDLE_GAP_MS = 30_000

const TRANSLATE_LANGUAGES = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'zh-CN', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
]

export default function Workspace() {
  const ws = useWorkspace()
  const {
    selectedPlaylistId,
    selectedLesson,
    setSelectedLesson,
    sentences,
    sentencesVideoId,
    currentSentenceIndex,
    setCurrentSentenceIndex,
    setIsPlaying,
    setCurrentTime,
    ignorePunctuation,
    ignoreCase,
    wordInputs,
    wordHintCounts,
    wordErrorChars,
    videoSessionScores,
    setVideoSessionScores,
    resetVideoSessionScores,
  } = ws

  const coachRef = useRef<CoachDrawerHandle | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const intervalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isWaitingForPauseIntervalRef = useRef(false)
  const repeatCountRef = useRef(0)
  const sentenceIndexFromPlaybackRef = useRef(false)

  // TTS voices
  const availableVoices = usePremiumVoices()

  // Speech-synthesis playback engine (word-by-word, grouping, repeat, pauses)
  const {
    resetTtsWordQueue,
    skipWord: ttsSkipWord,
    prevWord: ttsPrevWord,
    isCurrentSentenceFullyCorrectRef,
  } = useTtsPlayback({
    availableVoices,
    intervalTimeoutRef,
    isWaitingForPauseIntervalRef,
    repeatCountRef,
  })


  const userInitiatedSentenceChangeRef = useRef(false)
  const programmaticSeekRef = useRef(false)
  const skipNextSentenceResetRef = useRef(false)
  const wordInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const prevSentencesIdentityRef = useRef<string | null>(null)
  const prevVideoIdForScoresRef = useRef<number | null>(null)
  const getLocalDateTimeString = () => {
    const d = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  // Per-sentence typing stopwatch feeding the sidebar's WPM stat. Time is
  // measured from the first keystroke of a sentence until it reads fully
  // correct; sentences abandoned without completing are never counted.
  const typingStartRef = useRef<number | null>(null)
  const lastKeystrokeRef = useRef<number | null>(null)
  const sentenceElapsedRef = useRef(0)
  const sentenceCountedRef = useRef(false)

  const noteTypingActivity = useCallback(() => {
    const now = Date.now()
    const last = lastKeystrokeRef.current
    if (typingStartRef.current === null) {
      typingStartRef.current = now
    } else if (last !== null && now - last > TYPING_IDLE_GAP_MS) {
      // A gap this long means the user stepped away rather than waited for
      // speech: bank what was actually typed and restart the clock.
      sentenceElapsedRef.current += Math.max(0, last - typingStartRef.current)
      typingStartRef.current = now
    }
    lastKeystrokeRef.current = now
  }, [])

  const sessionStartedAtRef = useRef<string>(getLocalDateTimeString())
  const sessionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null)
  const [translationVisible, setTranslationVisible] = useState(false)
  const [translationLoading, setTranslationLoading] = useState(false)
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [translation, setTranslation] = useState<string | null>(null)
  const [translateLang, setTranslateLang] = useState<string>(
    () => localStorage.getItem('ear2finger-translate-lang') ?? 'vi'
  )
  // Read once per mount; Workspace remounts when returning from Settings
  const [keybinds] = useState(loadKeybindings)
  const [audio] = useState(loadAudioSettings)
  const errorBuzzOptions = {
    volume: audio.errorVolume,
    freqStart: audio.errorFreqStart,
    freqEnd: audio.errorFreqEnd,
    duration: audio.errorDuration,
    waveform: audio.errorWaveform,
  }
  const correctChimeOptions = {
    volume: audio.correctVolume,
    baseFreq: audio.correctBaseFreq,
    noteCount: audio.correctNoteCount,
    noteSpacing: audio.correctNoteSpacing,
    noteDuration: audio.correctNoteDuration,
    waveform: audio.correctWaveform,
  }
  const translationCacheRef = useRef<Map<string, string>>(new Map())
  const [lessonMenuOpen, setLessonMenuOpen] = useState<number | null>(null)
  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  // Desktop sidebar collapse, remembered across visits
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('ear2finger-workspace-sidebar') === 'collapsed'
  )
  useEffect(() => {
    localStorage.setItem(
      'ear2finger-workspace-sidebar',
      sidebarCollapsed ? 'collapsed' : 'expanded'
    )
  }, [sidebarCollapsed])
  /** One header button drives both breakpoints: drawer on mobile, collapse on desktop. */
  const toggleSidebar = useCallback(() => {
    if (window.matchMedia('(min-width: 768px)').matches) {
      setSidebarCollapsed((v) => !v)
    } else {
      setMobileSidebarOpen((v) => !v)
    }
  }, [])
  const [lastInputFeedback, setLastInputFeedback] = useState<{
    wordIndex: number
    type: 'correct' | 'wrong'
  } | null>(null)

  useEffect(() => {
    if (!lessonMenuOpen) return
    const onClose = () => setLessonMenuOpen(null)
    window.addEventListener('click', onClose)
    return () => window.removeEventListener('click', onClose)
  }, [lessonMenuOpen])

  useEffect(() => {
    if (!playlistMenuOpen) return
    const onClose = () => setPlaylistMenuOpen(false)
    window.addEventListener('click', onClose)
    return () => window.removeEventListener('click', onClose)
  }, [playlistMenuOpen])

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => {
      if (mq.matches) setMobileSidebarOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Clear input feedback after animation so it can replay on next keystroke
  useEffect(() => {
    if (lastInputFeedback === null) return
    const t = setTimeout(() => setLastInputFeedback(null), 550)
    return () => clearTimeout(t)
  }, [lastInputFeedback])


  // Load playlists and lessons on component mount
  useEffect(() => {
    fetchPlaylists()
  }, [])

  useEffect(() => {
    if (selectedPlaylistId) {
      fetchLessons()
    }
  }, [selectedPlaylistId])

  // When we have a selected lesson but sentences for another video (or none), fetch sentences.
  useEffect(() => {
    if (!selectedLesson) return
    if (sentencesVideoId === selectedLesson.video_id && sentences.length > 0) return
    fetchSentences(selectedLesson.video_id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchSentences is stable enough; avoid refetch loop
  }, [selectedLesson?.id, selectedLesson?.video_id, sentencesVideoId, sentences.length])

  // Reset per-video session scores only when user switches to a different video, not on first load or remount.
  useEffect(() => {
    const videoId = selectedLesson?.video_id ?? null
    if (prevVideoIdForScoresRef.current === videoId) return
    const hadPreviousVideo = prevVideoIdForScoresRef.current !== null
    prevVideoIdForScoresRef.current = videoId
    if (selectedLesson) sessionStartedAtRef.current = getLocalDateTimeString()
    if (hadPreviousVideo && videoId !== null) resetVideoSessionScores()
  }, [selectedLesson?.video_id, resetVideoSessionScores])


  // Fetch audio as blob so the request includes auth header
  const audioBlobUrlRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedLesson?.audio_file_path || !selectedLesson?.video_id) {
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
      setAudioBlobUrl(null)
      return
    }
    let cancelled = false
    api.get(`/api/youtube/videos/${selectedLesson.video_id}/audio`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return
        if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current)
        const url = URL.createObjectURL(res.data as Blob)
        audioBlobUrlRef.current = url
        setAudioBlobUrl(url)
      })
      .catch(() => !cancelled && setAudioBlobUrl(null))
    return () => {
      cancelled = true
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current)
        audioBlobUrlRef.current = null
      }
      setAudioBlobUrl(null)
    }
  }, [selectedLesson?.video_id, selectedLesson?.audio_file_path])

  const {
    notifications,
    isImportInProgress,
    pushNotification,
    fetchPlaylists,
    fetchLessons,
    fetchSentences,
    runImportInBackground,
  } = useLessonData()

  const handleLessonSelect = async (lesson: Lesson) => {
    setLessonMenuOpen(null)
    setMobileSidebarOpen(false)
    if (
      selectedLesson &&
      // The virtual tricky lesson keeps no session history
      !isTrickyLesson(selectedLesson) &&
      lesson.video_id !== selectedLesson.video_id &&
      (currentSentenceIndex >= 1 || isCurrentSentenceFullyCorrect)
    ) {
      saveLessonSession({
        video_id: selectedLesson.video_id,
        started_at: sessionStartedAtRef.current,
        ended_at: getLocalDateTimeString(),
        sentences_practiced: currentSentenceIndex + 1,
        correct_chars: videoSessionScores.correctChars,
        hint_count: videoSessionScores.hintCount,
        incorrect_chars: videoSessionScores.incorrectChars,
        typing_ms: videoSessionScores.typingMs,
      }).catch(() => { })
    }
    sessionStartedAtRef.current = getLocalDateTimeString()

    // Before switching lessons, hard-reset audio/TTS so Play cannot reuse the previous lesson's state.
    if (selectedLesson?.youtube_url?.startsWith('text://')) {
      window.speechSynthesis.cancel()
      setCurrentTime(0)
    } else if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current)
      audioBlobUrlRef.current = null
    }
    setAudioBlobUrl(null)

    setSelectedLesson(lesson)
    const nextSentences = await fetchSentences(lesson.video_id)

    // Try auto-resume from latest session history for this lesson.
    let resumed = false
    try {
      const sessions = isTrickyLesson(lesson) ? [] : await getLessonSessions(lesson.video_id)
      const latest = sessions[0]
      if (latest && latest.sentences_practiced > 0 && nextSentences.length > 0) {
        const targetIndex = Math.max(
          0,
          Math.min(nextSentences.length - 1, latest.sentences_practiced - 1)
        )
        const targetSentence = nextSentences[targetIndex]
        if (targetSentence) {
          // Avoid the sentence-list reset effect overriding this resume target.
          skipNextSentenceResetRef.current = true
          setVideoSessionScores({
            correctChars: latest.correct_chars,
            incorrectChars: latest.incorrect_chars,
            hintCount: latest.hint_count,
            typingMs: latest.typing_ms ?? 0,
          })
          userInitiatedSentenceChangeRef.current = true
          setCurrentSentenceIndex(targetIndex)
          setCurrentTime(targetSentence.start_time)
          if (lesson.youtube_url?.startsWith('text://')) {
            window.speechSynthesis.cancel()
          } else if (audioRef.current) {
            // Seek to resume point but stay paused; user must hit Play manually.
            audioRef.current.pause()
            audioRef.current.currentTime = targetSentence.start_time
          }
          setIsPlaying(false)
          resumed = true
        }
      }
    } catch {
      // keep default behavior if history fetch fails
    }

    if (resumed) {
      return
    }

    // No resumable history: start from beginning.
    setCurrentTime(0)
    setCurrentSentenceIndex(0)
    setIsPlaying(false)
    repeatCountRef.current = 0
    if (lesson.youtube_url?.startsWith('text://')) {
      window.speechSynthesis.cancel()
    } else if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    if (intervalTimeoutRef.current) {
      clearTimeout(intervalTimeoutRef.current)
      intervalTimeoutRef.current = null
    }
  }

  // Audio-element playback for non-text lessons (rate, advance, seek, play/pause)
  useAudioPlayback({
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
  })


  const fetchTranslation = useCallback((lang: string) => {
    const sentence = selectedLesson ? (sentences[currentSentenceIndex] || null) : null
    if (!sentence) return
    setTranslationVisible(true)
    setTranslationError(null)
    const cacheKey = `${sentence.id}:${lang}`
    const cached = translationCacheRef.current.get(cacheKey)
    if (cached) {
      setTranslation(cached)
      return
    }
    setTranslation(null)
    setTranslationLoading(true)
    translateText(sentence.sentence_text, lang)
      .then((data) => {
        translationCacheRef.current.set(cacheKey, data.translation)
        setTranslation(data.translation)
      })
      .catch((e) => {
        const err = e as { response?: { data?: { detail?: string } } }
        setTranslationError(
          err.response?.data?.detail ||
          'Translation is unavailable. Check your internet connection.'
        )
      })
      .finally(() => setTranslationLoading(false))
  }, [selectedLesson, sentences, currentSentenceIndex])

  const toggleTranslation = useCallback(() => {
    if (translationVisible) {
      setTranslationVisible(false)
      return
    }
    fetchTranslation(translateLang)
  }, [translationVisible, translateLang, fetchTranslation])

  const changeTranslateLang = useCallback((lang: string) => {
    setTranslateLang(lang)
    localStorage.setItem('ear2finger-translate-lang', lang)
    if (translationVisible) fetchTranslation(lang)
  }, [translationVisible, fetchTranslation])


  const normalizeWord = (w: string) => {
    let s = w
    if (ignoreCase) s = s.toLowerCase()
    if (ignorePunctuation) s = s.replace(/[^\w\s,.?!]/g, '')
    return s
  }

  const isPunctuationOnlyToken = (token: string) => {
    const trimmed = token.trim()
    if (!trimmed) return false
    // Common punctuation (, . ? !) must be typed, so a lone "," or "?!" is a
    // real input token, not decoration.
    if (/^[,.?!]+$/.test(trimmed)) return false
    // If there is at least one alphanumeric character, we treat it as a real word.
    return !/[0-9A-Za-z]/.test(trimmed)
  }

  const currentSentence = selectedLesson ? (sentences[currentSentenceIndex] || null) : null

  useWorkspaceShortcuts({
    currentSentence,
    keybinds,
    speedOptions: SPEED_OPTIONS,
    audioRef,
    intervalTimeoutRef,
    isWaitingForPauseIntervalRef,
    repeatCountRef,
    programmaticSeekRef,
    userInitiatedSentenceChangeRef,
    resetTtsWordQueue,
    skipWord: ttsSkipWord,
    prevWord: ttsPrevWord,
    toggleTranslation,
  })


  // Translation is per-sentence: hide it when navigating to another sentence
  useEffect(() => {
    setTranslationVisible(false)
    setTranslation(null)
    setTranslationError(null)
  }, [currentSentenceIndex, selectedLesson?.id])


  // Check if current sentence is fully correct (ignores punctuation-only tokens)
  const isCurrentSentenceFullyCorrect = currentSentence && (() => {
    const words = currentSentence.sentence_text.split(/\s+/).filter(Boolean)
    const norm = (w: string) => {
      let s = w
      if (ignoreCase) s = s.toLowerCase()
      if (ignorePunctuation) s = s.replace(/[^\w\s,.?!]/g, '')
      return s
    }
    const relevant = words
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => !isPunctuationOnlyToken(w))

    if (relevant.length === 0) return true

    return relevant.every(({ w, i }) => norm(w) === norm(wordInputs[i] ?? ''))
  })()


  // Play a celebration chime on the false→true edge of full correctness.
  // Initialized to the current value so a restored-complete sentence stays silent on mount.
  const prevFullyCorrectRef = useRef<boolean>(Boolean(isCurrentSentenceFullyCorrect))

  // Declared above the edge effect below so that on an index-change commit this
  // runs first: a stale-input spurious `true` then has no running clock to bank.
  useEffect(() => {
    typingStartRef.current = null
    lastKeystrokeRef.current = null
    sentenceElapsedRef.current = 0
    sentenceCountedRef.current = false
  }, [currentSentenceIndex, selectedLesson?.id])

  useEffect(() => {
    const now = Boolean(isCurrentSentenceFullyCorrect)
    if (now && !prevFullyCorrectRef.current) {
      if (!sentenceCountedRef.current && typingStartRef.current !== null) {
        // End the span at the last keystroke rather than now: correctness can
        // also flip long afterwards by toggling ignoreCase/ignorePunctuation.
        const end = lastKeystrokeRef.current ?? typingStartRef.current
        const span = Math.min(
          sentenceElapsedRef.current + Math.max(0, end - typingStartRef.current),
          MAX_SENTENCE_TYPING_MS
        )
        if (span > 0) {
          setVideoSessionScores((s) => ({ ...s, typingMs: s.typingMs + span }))
        }
        sentenceCountedRef.current = true
      }
      if (audio.correctEnabled) {
        playCelebrationChime(correctChimeOptions)
      }
    }
    prevFullyCorrectRef.current = now
  }, [isCurrentSentenceFullyCorrect, audio, currentSentenceIndex])

  // Keep the ref in sync so the TTS effect can read correctness without depending on it.
  useEffect(() => {
    isCurrentSentenceFullyCorrectRef.current = Boolean(isCurrentSentenceFullyCorrect)
  }, [isCurrentSentenceFullyCorrect, isCurrentSentenceFullyCorrectRef])

  const hasCompletedOneSentence =
    sentences.length > 0 &&
    (currentSentenceIndex >= 1 || Boolean(isCurrentSentenceFullyCorrect))


  // Auto-save lesson session when at least one sentence has been completed.
  useEffect(() => {
    if (!selectedLesson || !hasCompletedOneSentence || isTrickyLesson(selectedLesson)) return
    const payload = {
      video_id: selectedLesson.video_id,
      started_at: sessionStartedAtRef.current,
      ended_at: null as string | null,
      sentences_practiced: currentSentenceIndex + 1,
      correct_chars: videoSessionScores.correctChars,
      hint_count: videoSessionScores.hintCount,
      incorrect_chars: videoSessionScores.incorrectChars,
      typing_ms: videoSessionScores.typingMs,
    }
    if (sessionSaveTimeoutRef.current) clearTimeout(sessionSaveTimeoutRef.current)
    sessionSaveTimeoutRef.current = setTimeout(() => {
      sessionSaveTimeoutRef.current = null
      upsertCurrentLessonSession(payload).catch(() => { })
    }, 800)
    return () => {
      if (sessionSaveTimeoutRef.current) clearTimeout(sessionSaveTimeoutRef.current)
    }
  }, [
    selectedLesson?.id,
    hasCompletedOneSentence,
    currentSentenceIndex,
    videoSessionScores.correctChars,
    videoSessionScores.hintCount,
    videoSessionScores.incorrectChars,
    videoSessionScores.typingMs,
  ])

  const isLessonFinished =
    sentences.length > 0 &&
    currentSentenceIndex >= sentences.length - 1 &&
    Boolean(isCurrentSentenceFullyCorrect)




  const handleResumeLessonSession = (session: LessonSessionRecord) => {
    if (!selectedLesson || !sentences.length) return
    const targetIndex = Math.max(0, Math.min(sentences.length - 1, session.sentences_practiced - 1))
    const targetSentence = sentences[targetIndex]
    if (!targetSentence) return

    // Restore per-video scores
    setVideoSessionScores({
      correctChars: session.correct_chars,
      incorrectChars: session.incorrect_chars,
      hintCount: session.hint_count,
      typingMs: session.typing_ms ?? 0,
    })

    // Restore sentence index and audio position
    userInitiatedSentenceChangeRef.current = true
    setCurrentSentenceIndex(targetIndex)
    setCurrentTime(targetSentence.start_time)
    if (selectedLesson?.youtube_url?.startsWith('text://')) {
      // Browser SpeechSynthesis will pick it up on isPlaying = true
    } else if (audioRef.current) {
      audioRef.current.currentTime = targetSentence.start_time
      audioRef.current.play().catch(() => { })
    }
    setIsPlaying(true)
  }

  // Persist per-sentence learning progress whenever word inputs or hints change.
  // This keeps backend stats in sync even if the user doesn't fully complete a sentence.
  useEffect(() => {
    if (!currentSentence || !selectedLesson) return
    const words = currentSentence.sentence_text.split(/\s+/).filter(Boolean)
    if (!words.length) return

    const normalize = (w: string) => {
      let s = w
      if (ignoreCase) s = s.toLowerCase()
      if (ignorePunctuation) s = s.replace(/[^\w\s,.?!]/g, '')
      return s
    }

    const correctWords: string[] = []
    const incorrectWords: string[] = []
    const hintWords: string[] = []
    // Words the hint was revealed on 2+ times within THIS sentence — a much
    // stronger signal of trouble than needing it once.
    const repeatHintWords: string[] = []

    words.forEach((w, idx) => {
      const input = (wordInputs[idx] ?? '').trim()
      if (!input) return
      if (normalize(input) === normalize(w)) {
        correctWords.push(w)
      } else {
        incorrectWords.push(w)
      }
      const hints = wordHintCounts[idx] ?? 0
      if (hints > 0) {
        hintWords.push(w)
      }
      if (hints >= 2) {
        repeatHintWords.push(w)
      }
    })

    const data = {
      attempts: 1,
      total_words: words.length,
      words,
      correct_words: correctWords,
      incorrect_words: incorrectWords,
      hint_words: hintWords,
      repeat_hint_words: repeatHintWords,
      error_chars: wordErrorChars,
      completed: Boolean(isCurrentSentenceFullyCorrect),
    }

    api
      .post('/api/user/progress', {
        // Tricky sentences come from many lessons; credit the source lesson
        video_id: isTrickyLesson(selectedLesson)
          ? trickySentenceVideoId(currentSentence.id) ?? selectedLesson.video_id
          : selectedLesson.video_id,
        sentence_id: currentSentence.id,
        data,
      })
      .catch(() => {
      })
  }, [
    currentSentence,
    selectedLesson,
    wordInputs,
    wordHintCounts,
    ignoreCase,
    ignorePunctuation,
    isCurrentSentenceFullyCorrect,
  ])


  return (
    <div className="h-screen min-h-0 flex flex-col bg-transparent text-slate-100">
      {/* Header */}
      <AppHeader
        active="workspace"
        onToggleSidebar={toggleSidebar}
        sidebarControlsId="workspace-lessons-sidebar"
      />

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">

        <WorkspaceSidebar
          mobileSidebarOpen={mobileSidebarOpen}
          sidebarCollapsed={sidebarCollapsed}
          onLessonSelect={handleLessonSelect}
          onOpenImport={() => setIsImportModalOpen(true)}
          fetchPlaylists={fetchPlaylists}
          fetchLessons={fetchLessons}
          pushNotification={pushNotification}
        />

        {/* Main Content */}
        <main className="flex-1 flex flex-col overflow-hidden bg-abyss-950/40 p-3 md:p-4 gap-3 md:gap-4">
          <PlayerPanel
            audioRef={audioRef}
            audioBlobUrl={audioBlobUrl}
            currentSentence={currentSentence}
            intervalTimeoutRef={intervalTimeoutRef}
            isWaitingForPauseIntervalRef={isWaitingForPauseIntervalRef}
            repeatCountRef={repeatCountRef}
            userInitiatedSentenceChangeRef={userInitiatedSentenceChangeRef}
            programmaticSeekRef={programmaticSeekRef}
            wordInputRefs={wordInputRefs}
            resetTtsWordQueue={resetTtsWordQueue}
            ttsSkipWord={ttsSkipWord}
            ttsPrevWord={ttsPrevWord}
            isPunctuationOnlyToken={isPunctuationOnlyToken}
            keybinds={keybinds}
            onAskCoach={(videoId) => coachRef.current?.openForVideo(videoId)}
          />

          <DictationArea
            currentSentence={currentSentence}
            isCurrentSentenceFullyCorrect={Boolean(isCurrentSentenceFullyCorrect)}
            onTypingActivity={noteTypingActivity}
            wordInputRefs={wordInputRefs}
            normalizeWord={normalizeWord}
            isPunctuationOnlyToken={isPunctuationOnlyToken}
            audio={audio}
            errorBuzzOptions={errorBuzzOptions}
            lastInputFeedback={lastInputFeedback}
            setLastInputFeedback={setLastInputFeedback}
            keybinds={keybinds}
            translateLanguages={TRANSLATE_LANGUAGES}
            translateLang={translateLang}
            onChangeTranslateLang={changeTranslateLang}
            translationVisible={translationVisible}
            translationLoading={translationLoading}
            translationError={translationError}
            translation={translation}
            onToggleTranslation={toggleTranslation}
          />
        </main>
      </div>

      {/* Bottom bar: import progress + shortcuts */}
      <footer className="flex-shrink-0 border-t border-cyan-500/20 bg-abyss-900/90 backdrop-blur-md px-3 md:px-4 py-2 md:py-1.5 flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-6 text-xs text-slate-300">
        <div className="flex-1 min-w-0 md:pr-4">
          {isImportInProgress && (
            <div className="flex items-center gap-3">
              <span className="whitespace-nowrap text-cyan-400 font-medium animate-pulse">Importing lesson…</span>
              <div className="h-1.5 w-full bg-abyss-800 rounded-full overflow-hidden border border-cyan-500/30">
                <div
                  className="h-full w-2/5 bg-gradient-to-r from-cyan-400 to-teal-400 rounded-full shadow-glow-cyan"
                  style={{ animation: 'importProgress 1.5s ease-in-out infinite' }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 md:gap-3 flex-wrap justify-start md:justify-end">
          <span><kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.playPause)}</kbd> play/pause</span>
          <span><kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.replay)}</kbd> replay</span>
          <span><kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.prevSentence)}</kbd> previous</span>
          <span><kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.nextSentence)}</kbd> next</span>
          <span><kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">Shift+Space</kbd> prev word</span>
          <span><kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">Space</kbd> next word</span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">Tab</kbd> hint
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.speedDown)}</kbd>/<kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.speedUp)}</kbd> speed
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.wordByWord)}</kbd> WbW
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.prevWord)}</kbd> prev
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.skipWord)}</kbd> skip
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 bg-abyss-800 border border-cyan-500/30 text-cyan-300 rounded font-mono shadow-sm">{displayKey(keybinds.translate)}</kbd> translate
          </span>
        </div>
      </footer>

      {/* Import Modal */}
      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={runImportInBackground}
        defaultPlaylistId={selectedPlaylistId}
      />

      {/* Lesson History - bottom-right */}
      <LessonHistory
        videoId={selectedLesson && !isTrickyLesson(selectedLesson) ? selectedLesson.video_id : null}
        onResume={handleResumeLessonSession}
        isLessonFinished={isLessonFinished}
      />

      {/* Notifications */}
      <div className="fixed top-3 right-3 left-3 md:left-auto md:top-4 md:right-4 z-[60] space-y-2 max-md:max-w-none">
        {notifications.map((note) => (
          <div
            key={note.id}
            className={`w-full md:min-w-[280px] md:w-auto rounded-xl shadow-xl border px-4 py-3 text-sm font-semibold backdrop-blur-md transition-all ${note.type === 'success'
              ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/40 shadow-glow-emerald'
              : note.type === 'error'
                ? 'bg-rose-950/90 text-rose-200 border-rose-500/40 shadow-glow-rose'
                : 'bg-cyan-950/90 text-cyan-200 border-cyan-500/40 shadow-glow-cyan'
              }`}
            role="status"
          >
            {note.message}
          </div>
        ))}
      </div>

      {/* AI Coach side panel */}
      {AI_COACH_ENABLED && <CoachDrawer ref={coachRef} isLessonFinished={isLessonFinished} />}
    </div>
  )
}
