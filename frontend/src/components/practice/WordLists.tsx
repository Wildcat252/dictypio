import type { WordStat } from '../../api'

interface WordListsProps {
  words: WordStat[]
  binList: WordStat[]
  pageWords: WordStat[]
  page: number
  pageCount: number
  setPage: (fn: (p: number) => number) => void
  index: number
  tableVisible: boolean
  setTableVisible: (fn: (v: boolean) => boolean) => void
  binVisible: boolean
  setBinVisible: (fn: (v: boolean) => boolean) => void
  deleting: string | null
  bulkBusy: boolean
  goTo: (index: number) => void
  handleBin: (word: string) => void
  handleRecover: (word: string) => void
  handleDeleteForever: (word: string) => void
  handleRecoverAll: () => void
  handleDeleteAllForever: () => void
  displayOf: (word: string) => string
}

/** The tricky-words table and the recoverable word bin below the drill. */
export function WordLists({
  words,
  binList,
  pageWords,
  page,
  pageCount,
  setPage,
  index,
  tableVisible,
  setTableVisible,
  binVisible,
  setBinVisible,
  deleting,
  bulkBusy,
  goTo,
  handleBin,
  handleRecover,
  handleDeleteForever,
  handleRecoverAll,
  handleDeleteAllForever,
  displayOf,
}: WordListsProps) {
  return (
    <>
      {/* Word list */}
      <section className="bg-abyss-900/90 backdrop-blur-md rounded-2xl border border-cyan-500/25 p-4 shadow-glass-glow">
        <div className="flex items-center justify-between mb-1">
          <button
            type="button"
            onClick={() => setTableVisible((v) => !v)}
            title="Show or hide the list"
            className="flex items-center gap-1.5 text-sm font-bold text-slate-100 hover:text-cyan-300 transition-colors"
          >
            <span className={`transition-transform text-cyan-400 ${tableVisible ? '' : '-rotate-90'}`}>▾</span>
            Top tricky words
            <span className="font-normal text-cyan-400/70 text-xs">({words.length})</span>
          </button>
          <div className={`flex items-center gap-2 text-[11px] text-slate-400 ${tableVisible ? '' : 'hidden'}`}>
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-1.5 py-0.5 rounded-lg border border-cyan-500/30 bg-abyss-800/80 hover:border-cyan-400/50 hover:text-cyan-300 disabled:opacity-30 transition-all"
            >
              ‹
            </button>
            <span className="font-mono text-cyan-300/80">
              Page {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="px-1.5 py-0.5 rounded-lg border border-cyan-500/30 bg-abyss-800/80 hover:border-cyan-400/50 hover:text-cyan-300 disabled:opacity-30 transition-all"
            >
              ›
            </button>
          </div>
        </div>
        {!tableVisible ? null : (
          <>
        <p className="text-xs text-slate-400 mb-4">
          Words you asked for the hint on twice within the same sentence. Click one to
          practice it, or remove it once you've learnt it.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {pageWords.map((w) => {
            const rawRetry = w.latest_spell_retry_times ?? 0
            const retry = Math.max(1, Math.round(rawRetry))
            const label = displayOf(w.word)
            const globalIndex = words.findIndex((x) => x.word === w.word)
            const isActive = globalIndex === index
            const intensity =
              retry >= 9 ? 'bg-rose-600 shadow-glow-rose' :
                retry >= 7 ? 'bg-rose-500 shadow-glow-rose' :
                  retry >= 5 ? 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.6)]' :
                    retry >= 3 ? 'bg-amber-500 shadow-glow-amber' :
                      retry >= 2 ? 'bg-amber-400/80' :
                        'bg-teal-600/60'
            return (
              <div
                key={w.word}
                onClick={() => goTo(globalIndex)}
                className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 cursor-pointer transition-all ${isActive
                  ? 'border-cyan-400/70 bg-cyan-950/70 shadow-glow-cyan text-white'
                  : 'border-cyan-500/20 bg-abyss-800/60 hover:border-cyan-500/40 hover:bg-abyss-800/90 text-slate-200'
                  }`}
              >
                <div className="text-xs font-mono text-slate-100 truncate">{label}</div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`inline-block w-3 h-3 rounded-sm ${intensity}`}
                    title={`${retry} tries`}
                  />
                  <span className="text-[11px] text-slate-400 tabular-nums font-mono">{retry}×</span>
                  {(w.hint_count ?? 0) > 0 && (
                    <span
                      className="text-[11px] text-amber-400 tabular-nums"
                      title={`Hint used ${w.hint_count} time${w.hint_count === 1 ? '' : 's'}`}
                    >
                      💡{w.hint_count}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={deleting === w.word}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleBin(w.word)
                    }}
                    title="I've learnt this word — move it to the bin"
                    aria-label="Move to bin"
                    className="ml-1 p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-950/60 disabled:opacity-40 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
          </>
        )}
      </section>

      {/* Word bin — binned words are hidden from the drill but recoverable */}
      <section className="bg-abyss-900/90 backdrop-blur-md rounded-2xl border border-cyan-500/25 p-4 shadow-glass-glow">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setBinVisible((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-bold text-slate-100 hover:text-cyan-300 transition-colors"
          >
            <span className={`transition-transform text-cyan-400 ${binVisible ? '' : '-rotate-90'}`}>▾</span>
            Word bin
            <span className="font-normal text-cyan-400/70 text-xs">({binList.length})</span>
          </button>
          {binVisible && binList.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={bulkBusy}
                onClick={handleRecoverAll}
                title="Recover all"
                aria-label="Recover all"
                className="p-1.5 rounded-lg text-slate-400 hover:text-teal-300 hover:bg-teal-950/60 disabled:opacity-40 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10a8 8 0 1114.32 4.9M3 10V4m0 6h6" />
                </svg>
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={handleDeleteAllForever}
                title="Delete all permanently"
                aria-label="Delete all permanently"
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/60 disabled:opacity-40 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {binVisible && (
          <>
            {binList.length === 0 ? (
              <p className="text-xs text-slate-400 mt-3">The bin is empty.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mt-3">
                {binList.map((w) => (
                  <div
                    key={w.word}
                    className="flex items-center justify-between gap-2 rounded-xl border border-cyan-500/20 bg-abyss-800/60 px-3 py-2"
                  >
                    <div className="text-xs font-mono text-slate-300 truncate">
                      {displayOf(w.word)}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={deleting === w.word || bulkBusy}
                        onClick={() => handleRecover(w.word)}
                        title="Recover"
                        aria-label="Recover"
                        className="p-1 rounded-lg text-slate-400 hover:text-teal-300 hover:bg-teal-950/60 disabled:opacity-40 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10a8 8 0 1114.32 4.9M3 10V4m0 6h6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        disabled={deleting === w.word || bulkBusy}
                        onClick={() => handleDeleteForever(w.word)}
                        title="Delete permanently — this cannot be undone"
                        aria-label="Delete permanently"
                        className="p-1 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/60 disabled:opacity-40 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </>
  )
}
