import type { MutableRefObject } from 'react'

const SPEED_OPTIONS = [0.2, 0.4, 0.6, 0.8, 1, 1.2]

interface DrillCardProps {
  index: number
  words: { length: number }
  target: string
  value: string
  isCorrect: boolean
  hintShown: boolean
  underlineClass: string
  playbackSpeed: number
  inputRef: MutableRefObject<HTMLInputElement | null>
  translationVisible: boolean
  translationLoading: boolean
  translationError: string | null
  translation: string | null
  handleChange: (next: string) => void
  setHintShown: (fn: (h: boolean) => boolean) => void
  speak: (text: string) => void
  spell: () => void
  toggleTranslation: () => void
  stepSpeed: (direction: 1 | -1) => void
  goTo: (index: number) => void
  goRandom: () => void
}

/** The listen-and-type drill: replay/spell/hint/translate, input, and nav. */
export function DrillCard({
  index,
  words,
  target,
  value,
  isCorrect,
  hintShown,
  underlineClass,
  playbackSpeed,
  inputRef,
  translationVisible,
  translationLoading,
  translationError,
  translation,
  handleChange,
  setHintShown,
  speak,
  spell,
  toggleTranslation,
  stepSpeed,
  goTo,
  goRandom,
}: DrillCardProps) {
  return (
    <>
      {/* Drill */}
      {words.length === 0 ? (
        <div className="bg-abyss-900/90 backdrop-blur-md rounded-2xl border border-cyan-500/25 p-6 text-center shadow-glass-glow">
          <p className="text-sm text-slate-200 font-semibold">Every word is in the bin.</p>
          <p className="text-xs text-slate-400 mt-1">
            Recover one below to keep practicing.
          </p>
        </div>
      ) : (
      <section className="bg-abyss-900/90 backdrop-blur-md rounded-2xl border border-cyan-500/25 p-5 md:p-6 shadow-glass-glow">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold bg-gradient-to-r from-cyan-300 to-teal-200 bg-clip-text text-transparent">
            Listen and type the word
          </h2>
          <span className="text-xs text-cyan-400 font-mono bg-abyss-800/80 border border-cyan-500/30 px-2.5 py-0.5 rounded-full">
            {index + 1} / {words.length}
          </span>
        </div>

        <div className="flex items-center flex-wrap gap-2.5 mb-5">
          <button
            type="button"
            onClick={() => speak(target)}
            title="Replay the word (Enter)"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-white text-sm font-semibold shadow-glow-cyan transition-all transform hover:scale-[1.03] active:scale-[0.97]"
          >
            ▶ Replay
          </button>
          <button
            type="button"
            onClick={spell}
            title="Spell the word letter by letter (\)"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-cyan-500/30 bg-abyss-800/90 text-sm text-slate-200 hover:text-cyan-300 hover:border-cyan-400/60 hover:bg-abyss-750 transition-all"
          >
            Spell
          </button>
          <button
            type="button"
            onClick={() => setHintShown((h) => !h)}
            title="Reveal or hide the word (Tab)"
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-sm font-semibold transition-all ${hintShown
              ? 'border-amber-400/60 bg-amber-950/80 text-amber-300 shadow-glow-amber'
              : 'border-amber-500/30 bg-abyss-800/80 text-amber-300/80 hover:bg-amber-950/60 hover:border-amber-400/50'
              }`}
          >
            Hint
          </button>
          <button
            type="button"
            onClick={toggleTranslation}
            title="Translate the word (`)"
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border text-sm font-semibold transition-all ${translationVisible
              ? 'border-cyan-400 bg-cyan-950/80 text-cyan-200 shadow-glow-cyan'
              : 'border-cyan-500/30 bg-abyss-800/80 text-slate-300 hover:text-cyan-300 hover:border-cyan-400/50'
              }`}
          >
            Translate
          </button>

          <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-300">
            <span className="mr-1 text-cyan-400 font-semibold">Speed</span>
            <button
              type="button"
              onClick={() => stepSpeed(-1)}
              disabled={playbackSpeed <= SPEED_OPTIONS[0]}
              title="Slower (-)"
              className="w-7 h-7 rounded-lg border border-cyan-500/30 bg-abyss-800/90 hover:bg-abyss-750 hover:text-cyan-300 hover:border-cyan-400/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all font-bold"
            >
              −
            </button>
            <span className="w-10 text-center tabular-nums font-mono font-bold text-cyan-300">
              {playbackSpeed}x
            </span>
            <button
              type="button"
              onClick={() => stepSpeed(1)}
              disabled={playbackSpeed >= SPEED_OPTIONS[SPEED_OPTIONS.length - 1]}
              title="Faster (=)"
              className="w-7 h-7 rounded-lg border border-cyan-500/30 bg-abyss-800/90 hover:bg-abyss-750 hover:text-cyan-300 hover:border-cyan-400/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all font-bold"
            >
              +
            </button>
          </div>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Type what you hear…"
          aria-label="Practice word"
          autoComplete="off"
          spellCheck={false}
          className={`font-typing w-full bg-transparent border-0 outline-none px-1.5 py-1.5 text-slate-100 placeholder:text-slate-600 ${underlineClass}`}
          style={{ fontSize: 'clamp(1.4rem, 5vw, 2.5rem)' }}
        />

        <div className="mt-3 min-h-[1.75rem] flex items-center gap-3">
          {isCorrect && (
            <span className="inline-flex items-center gap-1.5 text-emerald-400 font-bold text-sm drop-shadow-[0_0_10px_rgba(52,211,153,0.7)]">
              ✔ Correct
            </span>
          )}
          {hintShown && !isCorrect && (
            <span className="font-mono text-amber-300 text-lg drop-shadow-[0_0_8px_rgba(251,191,36,0.55)]">{target}</span>
          )}
        </div>

        {translationVisible && (
          <div className="mt-2 text-sm md:text-base text-cyan-200/90 bg-abyss-950/60 border border-cyan-500/20 rounded-xl p-3 italic">
            {translationLoading && <span className="animate-pulse text-cyan-300 font-normal">Translating…</span>}
            {translationError && (
              <span className="text-rose-400 not-italic">{translationError}</span>
            )}
            {translation && !translationLoading && !translationError && (
              <span>{translation}</span>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between border-t border-cyan-500/20 pt-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              className="px-3 py-1.5 text-sm border border-cyan-500/30 bg-abyss-800/80 text-slate-200 rounded-xl hover:text-cyan-300 hover:border-cyan-400/50 hover:bg-abyss-750 transition-all"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              className="px-3 py-1.5 text-sm border border-cyan-500/30 bg-abyss-800/80 text-slate-200 rounded-xl hover:text-cyan-300 hover:border-cyan-400/50 hover:bg-abyss-750 transition-all"
            >
              Next
            </button>
            <button
              type="button"
              onClick={goRandom}
              title="Jump to a random word (/)"
              className="px-3 py-1.5 text-sm border border-cyan-500/30 bg-abyss-800/80 text-slate-200 rounded-xl hover:text-cyan-300 hover:border-cyan-400/50 hover:bg-abyss-750 transition-all"
            >
              random
            </button>
          </div>
        </div>
      </section>
      )}
    </>
  )
}
