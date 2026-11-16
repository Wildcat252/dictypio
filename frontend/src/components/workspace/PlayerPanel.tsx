import type { MouseEvent as ReactMouseEvent, MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspace, type Sentence } from '../../contexts/WorkspaceContext'
import { displayKey, type Keybindings } from '../../keybindings'
import { AI_COACH_ENABLED } from '../../features'
import { cancelSpeech } from '../../tts'

const SPEED_OPTIONS = [0.2, 0.4, 0.6, 0.8, 1, 1.2]
// How many times each word is spoken in word-by-word mode

/**
 * A small select-style dropdown.
 *
 * The menu is portalled into document.body: the workspace panels use
 * `backdrop-blur`, which creates a stacking context on each panel, so an
 * in-tree menu can never paint over the panel that follows it.
 */
export const MOBILE_HINT_SLOT_ID = 'mobile-hint-slot'

function OptionMenu({
  label,
  value,
  options,
  onSelect,
  suffix = 'x',
}: {
  label: string
  value: number
  options: readonly number[]
  onSelect: (value: number) => void
  suffix?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setPos({ top: rect.bottom + 6, left: rect.left })
    }
    place()
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', place)
    // capture phase: the menu is anchored to a trigger inside a scrollable panel
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative">
      <div
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${value}${suffix}`}
        onClick={() => setOpen((v) => !v)}
        className="max-md:min-h-[28px] max-md:px-1.5 max-md:py-0.5 max-md:gap-1 max-md:text-[11px] max-md:shrink-0 bg-abyss-800/90 hover:bg-abyss-750 border border-cyan-500/30 text-cyan-200 px-3 py-1.5 rounded-xl flex items-center gap-2 text-xs font-medium cursor-pointer shadow-sm transition-all hover:border-cyan-400/60"
      >
        <span><span className="max-md:hidden">{label}: </span>{value}{suffix}</span>
        <svg
          className={`w-3.5 h-3.5 text-cyan-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className="z-[100] bg-abyss-850/95 backdrop-blur-md border border-cyan-500/30 rounded-xl shadow-glass-glow text-slate-200 min-w-[120px] py-1"
        >
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onSelect(option)
                setOpen(false)
              }}
              className={`w-full text-left px-3.5 py-1.5 max-md:py-3 max-md:text-sm text-xs transition-colors ${option === value ? 'bg-cyan-950/60 text-cyan-300 font-semibold' : 'hover:bg-abyss-800 text-slate-200'
                }`}
            >
              {option}{suffix}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface PlayerPanelProps {
  audioRef: MutableRefObject<HTMLAudioElement | null>
  audioBlobUrl: string | null
  currentSentence: Sentence | null
  /** Refs shared with the TTS engine / audio-playback effects */
  intervalTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  isWaitingForPauseIntervalRef: MutableRefObject<boolean>
  repeatCountRef: MutableRefObject<number>
  userInitiatedSentenceChangeRef: MutableRefObject<boolean>
  programmaticSeekRef: MutableRefObject<boolean>
  wordInputRefs: MutableRefObject<(HTMLInputElement | null)[]>
  resetTtsWordQueue: () => void
  ttsSkipWord: () => void
  ttsPrevWord: () => void
  isPunctuationOnlyToken: (token: string) => boolean
  keybinds: Keybindings
  onAskCoach: (videoId: number) => void
}

/**
 * Top panel of the workspace: lesson title, the hidden <audio> element,
 * transport controls with the progress bar, and the settings/score row.
 */
export function PlayerPanel({
  audioRef,
  audioBlobUrl,
  currentSentence,
  intervalTimeoutRef,
  isWaitingForPauseIntervalRef,
  repeatCountRef,
  userInitiatedSentenceChangeRef,
  programmaticSeekRef,
  wordInputRefs,
  resetTtsWordQueue,
  ttsSkipWord,
  ttsPrevWord,
  isPunctuationOnlyToken,
  keybinds,
  onAskCoach,
}: PlayerPanelProps) {
  const {
    selectedLesson,
    sentences,
    currentSentenceIndex,
    setCurrentSentenceIndex,
    isPlaying,
    setIsPlaying,
    currentTime,
    setCurrentTime,
    playbackSpeed,
    setPlaybackSpeed,
    ttsWordByWord,
    setTtsWordByWord,
    videoSessionScores,
  } = useWorkspace()

  const isTextLesson = Boolean(selectedLesson?.youtube_url?.startsWith('text://'))
  const totalDuration = selectedLesson?.duration || 0
  const sentenceCount = sentences.length

  // Phones: tapping a player button must not close the on-screen keyboard.
  // Remember the word input that had focus when the tap started, stop the
  // button from taking focus, and hand focus back after the click ran.
  const typingInputRef = useRef<HTMLInputElement | null>(null)
  const isWordInput = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement && wordInputRefs.current.includes(el)
  const keepKeyboardOnPointerDown = (e: ReactPointerEvent | ReactMouseEvent) => {
    const target = e.target as HTMLElement
    if (!target.closest('button')) return
    const active = document.activeElement
    if (!isWordInput(active)) return
    typingInputRef.current = active
    e.preventDefault()
  }
  const restoreKeyboardAfterClick = () => {
    const prev = typingInputRef.current
    typingInputRef.current = null
    if (!prev) return
    const refocus = () => {
      if (isWordInput(document.activeElement)) return
      const target = prev.isConnected
        ? prev
        : wordInputRefs.current.find((el) => el && el.isConnected && !el.disabled)
      target?.focus({ preventScroll: true })
    }
    // Synchronously (still inside the tap, so iOS keeps the keyboard up) and
    // once more after React re-renders the sentence on next/previous.
    refocus()
    requestAnimationFrame(refocus)
  }

  // Lock-screen / Control Center "Now Playing" card: give it a proper
  // full-bleed square artwork instead of letting iOS guess from the page.
  const lessonTitle = selectedLesson?.title
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    if (typeof MediaMetadata === 'undefined') return
    const origin = window.location.origin
    navigator.mediaSession.metadata = new MediaMetadata({
      title: lessonTitle || 'Dictypio',
      artist: 'Dictypio',
      album: 'English Listening & Dictation',
      artwork: [
        { src: `${origin}/apple-touch-icon.png`, sizes: '180x180', type: 'image/png' },
        { src: `${origin}/icon-512.png`, sizes: '512x512', type: 'image/png' },
      ],
    })
  }, [lessonTitle])

  return (
    <div
      onPointerDown={keepKeyboardOnPointerDown}
      onMouseDown={keepKeyboardOnPointerDown}
      onClick={restoreKeyboardAfterClick}
      className="w-full max-w-4xl mx-auto shrink-0 bg-abyss-900/90 backdrop-blur-md rounded-2xl border border-cyan-500/25 p-2.5 md:p-4 shadow-glass-glow"
    >
      <div className="mb-1.5 md:mb-4 text-center">
        <h1 className="text-base md:text-xl font-bold bg-gradient-to-r from-slate-100 via-cyan-100 to-teal-200 bg-clip-text text-transparent text-center max-md:line-clamp-1 md:line-clamp-2 tracking-wide">
          {selectedLesson?.title || 'Select a lesson'}
        </h1>
      </div>

      {/* Audio Element (hidden) */}
      {selectedLesson && (
        <audio
          ref={audioRef}
          src={audioBlobUrl ?? undefined}
          onLoadedMetadata={() => {
            if (audioRef.current != null && currentTime >= 0) {
              audioRef.current.currentTime = currentTime
            }
          }}
          onEnded={() => {
            setIsPlaying(false)
          }}
          onError={(e) => {
            console.error('Audio playback error:', e)
            setIsPlaying(false)
          }}
        />
      )}

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4 mb-1.5 md:mb-4">
        {/* Media Player */}
        <div className="flex-1 flex flex-nowrap items-center justify-start gap-1.5 md:gap-2.5 min-w-0 w-full">
          <button
            onClick={() => {
              if (currentSentenceIndex > 0) {
                userInitiatedSentenceChangeRef.current = true
                const prevIndex = currentSentenceIndex - 1
                setCurrentSentenceIndex(prevIndex)
                repeatCountRef.current = 0
                resetTtsWordQueue()
                if (isTextLesson) {
                  setCurrentTime(sentences[prevIndex].start_time)
                } else if (audioRef.current && sentences[prevIndex]) {
                  audioRef.current.currentTime = sentences[prevIndex].start_time
                  setCurrentTime(sentences[prevIndex].start_time)
                }
              }
            }}
            disabled={currentSentenceIndex === 0}
            className="max-md:w-7 max-md:h-7 shrink-0 flex items-center justify-center p-1 md:p-2 rounded-lg md:rounded-xl text-slate-300 hover:text-cyan-300 hover:bg-abyss-800 border border-cyan-500/20 hover:border-cyan-400/50 shadow-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            title="Previous sentence"
          >
            <svg className="w-4 h-4 md:w-5 md:h-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M8.445 14.832A1 1 0 0010 14v-2.798l5.445 3.63A1 1 0 0017 14V6a1 1 0 00-1.555-.832L10 8.798V6a1 1 0 00-1.555-.832l-6 4a1 1 0 000 1.664l6 4z" />
            </svg>
          </button>
          <button
            onClick={() => {
              if (!selectedLesson || !sentences.length) return
              setIsPlaying(!isPlaying)
              // When the user hits Play, move the cursor to the first input-able word (skip punctuation-only tokens).
              if (currentSentence) {
                const words = currentSentence.sentence_text.split(/\s+/).filter(Boolean)
                const firstInputIndex = words.findIndex((w) => !isPunctuationOnlyToken(w))
                if (firstInputIndex >= 0) {
                  wordInputRefs.current[firstInputIndex]?.focus()
                }
              }
            }}
            disabled={!selectedLesson || !sentences.length}
            className="max-md:w-9 max-md:h-7 shrink-0 flex items-center justify-center p-1 md:p-2.5 rounded-lg md:rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-white shadow-glow-cyan transition-all transform hover:scale-105 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg className="w-4 h-4 md:w-5 md:h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-4 h-4 md:w-5 md:h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => {
              if (!selectedLesson || !sentences.length || !currentSentence) return
              // Reset word queue so TTS restarts from word 0
              resetTtsWordQueue()
              repeatCountRef.current = 0
              if (isTextLesson) {
                // Cancel current speech, then re-trigger by toggling isPlaying
                cancelSpeech()
                setIsPlaying(false)
                setTimeout(() => setIsPlaying(true), 10)
              } else if (audioRef.current) {
                audioRef.current.currentTime = currentSentence.start_time
                setCurrentTime(currentSentence.start_time)
                programmaticSeekRef.current = true
                audioRef.current.play().catch(() => { })
                setIsPlaying(true)
              }
            }}
            disabled={!selectedLesson || !sentences.length}
            className="max-md:w-7 max-md:h-7 shrink-0 flex items-center justify-center p-1 md:p-2 rounded-lg md:rounded-xl text-slate-300 hover:text-cyan-300 hover:bg-abyss-800 border border-cyan-500/20 hover:border-cyan-400/50 shadow-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            title="Replay current sentence"
          >
            <svg className="w-4 h-4 md:w-5 md:h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311V15a.75.75 0 01-1.5 0v-3.5a.75.75 0 01.75-.75H8.5a.75.75 0 010 1.5H7.058l.162.162a4 4 0 006.693-1.793.75.75 0 011.399.555zM4.688 8.576a5.5 5.5 0 019.201-2.466l.312.311V5a.75.75 0 011.5 0v3.5a.75.75 0 01-.75.75H11.5a.75.75 0 010-1.5h1.442l-.162-.162a4 4 0 00-6.693 1.793.75.75 0 11-1.399-.555z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={() => {
              if (currentSentenceIndex >= sentences.length - 1) return
              const nextIndex = currentSentenceIndex + 1
              const nextSentence = sentences[nextIndex]
              if (!nextSentence) return
              userInitiatedSentenceChangeRef.current = true
              // Cancel any pause-interval timeout so it doesn't fire after we skip
              if (intervalTimeoutRef.current) {
                clearTimeout(intervalTimeoutRef.current)
                intervalTimeoutRef.current = null
              }
              isWaitingForPauseIntervalRef.current = false
              repeatCountRef.current = 0
              resetTtsWordQueue()
              setCurrentSentenceIndex(nextIndex)
              setCurrentTime(nextSentence.start_time)
              if (isTextLesson) {
                setCurrentTime(nextSentence.start_time)
              } else if (audioRef.current) {
                audioRef.current.currentTime = nextSentence.start_time
                audioRef.current.play().catch(() => { })
              }
              setIsPlaying(true)
            }}
            disabled={currentSentenceIndex >= sentences.length - 1}
            className="max-md:w-7 max-md:h-7 shrink-0 flex items-center justify-center p-1 md:p-2 rounded-lg md:rounded-xl text-slate-300 hover:text-cyan-300 hover:bg-abyss-800 border border-cyan-500/20 hover:border-cyan-400/50 shadow-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next sentence"
          >
            <svg className="w-4 h-4 md:w-5 md:h-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M4.555 5.168A1 1 0 003 6v8a1 1 0 001.555.832L10 11.202V14a1 1 0 001.555.832l6-4a1 1 0 000-1.664l-6-4A1 1 0 0011 6v2.798l-5.445-3.63z" />
            </svg>
          </button>
          <div className="flex-1 flex items-center gap-1.5 md:gap-3 min-w-0">
            <div
              className="flex-1 min-w-0 h-1.5 md:h-2.5 rounded-full overflow-hidden relative pointer-events-none bg-abyss-950 border border-cyan-500/20"
              aria-hidden
            >
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-cyan-400 via-teal-400 to-emerald-400 rounded-full origin-left shadow-glow-cyan"
                style={{
                  width: `${isTextLesson
                    ? sentences.length > 0
                      ? Math.min(100, ((currentSentenceIndex + 1) / sentences.length) * 100)
                      : 0
                    : totalDuration > 0
                      ? Math.min(100, (currentTime / totalDuration) * 100)
                      : 0
                    }%`,
                  transition: 'width 0.2s linear'
                }}
              />
            </div>
            <span className="text-xs text-slate-300 font-mono md:min-w-[3.5rem] whitespace-nowrap">
              {isTextLesson ? (
                <span className="text-cyan-300 bg-abyss-800/80 border border-cyan-500/30 text-xs font-semibold rounded-full px-2 md:px-2.5 py-0.5 shadow-sm">
                  <span className="max-md:hidden">Sentence </span>{currentSentenceIndex + 1} / {sentences.length}
                </span>
              ) : (
                <>
                  <span className="max-md:hidden"><span className="text-slate-300">{formatTime(currentTime)}</span> / <span className="text-slate-400">{formatTime(totalDuration)}</span></span>
                  {sentenceCount > 0 && (
                    <span className="md:ml-2 text-cyan-300 bg-abyss-800/80 border border-cyan-500/30 text-xs font-semibold rounded-full px-2 py-0.5 shadow-sm">
                      {currentSentenceIndex + 1} / {sentenceCount}
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
          <div id={MOBILE_HINT_SLOT_ID} className="md:hidden shrink-0 empty:hidden" />
        </div>
      </div>

      {/* Controls */}
      <div className="flex max-md:flex-nowrap md:flex-wrap items-center gap-1 md:gap-2.5">
        <OptionMenu
          label="Speed"
          value={playbackSpeed}
          options={SPEED_OPTIONS}
          onSelect={setPlaybackSpeed}
        />
        {isTextLesson && (
          <button
            type="button"
            aria-pressed={ttsWordByWord}
            title="Word gap, letters per gap and repeat: Settings › Playback & Grading"
            className={`max-md:min-h-[28px] max-md:px-1.5 max-md:py-0.5 max-md:gap-1 max-md:text-[11px] max-md:shrink-0 px-3 py-1.5 rounded-xl flex items-center gap-2 text-xs font-semibold cursor-pointer border transition-all ${ttsWordByWord
              ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white border-cyan-400 shadow-glow-cyan'
              : 'bg-abyss-800/90 text-slate-300 border-cyan-500/30 hover:border-cyan-400/50 hover:bg-abyss-750'
              }`}
            onClick={() => {
              // Reset word queue before toggling so the effect re-enters cleanly
              resetTtsWordQueue()
              setTtsWordByWord(!ttsWordByWord)
            }}
          >
            <span><span className="max-md:hidden">Word-by-Word</span><span className="md:hidden">WbW</span><span className="max-md:hidden">: {ttsWordByWord ? 'ON' : 'OFF'}</span></span>
          </button>
        )}
        {isTextLesson && ttsWordByWord && (
          <>
          {/* Phones: prev/skip word as compact icons */}
          <button
            type="button"
            onClick={() => ttsPrevWord()}
            aria-label="Previous word"
            className="md:hidden w-7 h-7 shrink-0 flex items-center justify-center bg-abyss-800/90 border border-cyan-500/30 text-slate-200 rounded-xl text-sm"
          >
            ⏮
          </button>
          <button
            type="button"
            onClick={() => ttsSkipWord()}
            aria-label="Skip word"
            className="md:hidden w-7 h-7 shrink-0 flex items-center justify-center bg-abyss-800/90 border border-cyan-500/30 text-slate-200 rounded-xl text-sm"
          >
            ⏭
          </button>
          </>
        )}
        {isTextLesson && ttsWordByWord && (
          <button
            type="button"
            onClick={() => ttsPrevWord()}
            title={`Go back to previous word (${displayKey(keybinds.prevWord)})`}
            className="max-md:hidden bg-abyss-800/90 hover:bg-abyss-750 border border-cyan-500/30 hover:border-cyan-400/60 text-slate-200 hover:text-cyan-300 max-md:min-h-[28px] max-md:px-1.5 max-md:py-0.5 max-md:gap-1 max-md:text-[11px] max-md:shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-all shadow-sm"
          >
            ⏮ Prev
          </button>
        )}
        {isTextLesson && ttsWordByWord && (
          <button
            type="button"
            onClick={() => ttsSkipWord()}
            title={`Skip word (${displayKey(keybinds.skipWord)})`}
            className="max-md:hidden bg-abyss-800/90 hover:bg-abyss-750 border border-cyan-500/30 hover:border-cyan-400/60 text-slate-200 hover:text-cyan-300 max-md:min-h-[28px] max-md:px-1.5 max-md:py-0.5 max-md:gap-1 max-md:text-[11px] max-md:shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-all shadow-sm"
          >
            Skip ⏭
          </button>
        )}
        <div className="flex max-md:flex-nowrap md:flex-wrap items-center gap-1 md:gap-2.5 ml-auto justify-end shrink-0">
          <div className="flex items-center gap-1.5 bg-abyss-950/70 border border-emerald-500/30 rounded-md md:rounded-lg px-1 md:px-2.5 py-0.5 md:py-1 gap-1 md:gap-1.5" title="Correct keystrokes" aria-label={`Correct keystrokes: ${videoSessionScores.correctChars}`}>
            <div className="w-1.5 h-1.5 md:w-2.5 md:h-2.5 bg-emerald-400 rounded-full shadow-glow-emerald" />
            <span className="text-[11px] md:text-xs font-mono font-semibold text-emerald-300">{videoSessionScores.correctChars}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-abyss-950/70 border border-amber-500/30 rounded-md md:rounded-lg px-1 md:px-2.5 py-0.5 md:py-1 gap-1 md:gap-1.5" title="Hints used" aria-label={`Hints used: ${videoSessionScores.hintCount}`}>
            <div className="w-1.5 h-1.5 md:w-2.5 md:h-2.5 bg-amber-400 rounded-full shadow-glow-amber" />
            <span className="text-[11px] md:text-xs font-mono font-semibold text-amber-300">{videoSessionScores.hintCount}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-abyss-950/70 border border-rose-500/30 rounded-md md:rounded-lg px-1 md:px-2.5 py-0.5 md:py-1 gap-1 md:gap-1.5" title="Incorrect keystrokes" aria-label={`Incorrect keystrokes: ${videoSessionScores.incorrectChars}`}>
            <div className="w-1.5 h-1.5 md:w-2.5 md:h-2.5 bg-rose-400 rounded-full shadow-glow-rose" />
            <span className="text-[11px] md:text-xs font-mono font-semibold text-rose-300">{videoSessionScores.incorrectChars}</span>
          </div>
          {AI_COACH_ENABLED && selectedLesson && selectedLesson.video_id > 0 && (
            <button
              type="button"
              onClick={() => onAskCoach(selectedLesson.video_id)}
              className="ml-2 max-md:min-h-[40px] inline-flex items-center rounded-full border border-cyan-400/50 bg-gradient-to-r from-cyan-950/80 to-teal-950/80 px-3.5 py-1 text-xs font-semibold text-cyan-300 hover:text-white hover:bg-cyan-900/60 shadow-glow-cyan transition-all transform hover:scale-105 active:scale-95"
            >
              Ask coach
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
