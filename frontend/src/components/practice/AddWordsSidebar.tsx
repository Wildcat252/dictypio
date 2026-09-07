interface AddWordsSidebarProps {
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  newWords: string
  setNewWords: (v: string) => void
  adding: boolean
  addMessage: string | null
  customWords: string[]
  binnedSet: Set<string>
  handleAddWords: () => void
  displayOf: (word: string) => string
}

/** Sidebar for adding your own practice words, plus the list of them. */
export function AddWordsSidebar({
  sidebarOpen,
  sidebarCollapsed,
  newWords,
  setNewWords,
  adding,
  addMessage,
  customWords,
  binnedSet,
  handleAddWords,
  displayOf,
}: AddWordsSidebarProps) {
  return (
    <aside
      className={`w-full md:w-72 shrink-0 bg-abyss-900/95 border-cyan-500/20 border-b md:border-b-0 md:border-r flex flex-col min-h-0 overflow-y-auto backdrop-blur-md ${sidebarOpen ? '' : 'max-md:hidden'
        } ${sidebarCollapsed ? 'md:hidden' : ''}`}
    >

      <div className="p-4">
        <h2 className="text-sm font-bold bg-gradient-to-r from-cyan-300 to-teal-200 bg-clip-text text-transparent">Add words</h2>
        <p className="text-xs text-slate-400 mt-1 mb-3">
          Type or paste words to practice, separated by commas, spaces or new lines.
        </p>
        <textarea
          value={newWords}
          onChange={(e) => setNewWords(e.target.value)}
          onKeyDown={(e) => {
            // Keep typing local so the page shortcuts don't fire in here
            e.stopPropagation()
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleAddWords()
            }
          }}
          rows={8}
          placeholder={'accommodate\nrhythm, liaison\nconscience'}
          className="w-full border-2 border-cyan-500/30 bg-abyss-800/90 text-slate-100 placeholder:text-slate-600 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent resize-none transition-all"
        />
        <button
          type="button"
          onClick={handleAddWords}
          disabled={adding || newWords.trim().length === 0}
          className="mt-2.5 w-full px-3 py-2.5 bg-gradient-to-r from-cyan-500 via-teal-500 to-sky-600 hover:from-cyan-400 hover:via-teal-400 hover:to-sky-500 text-white text-sm font-bold rounded-xl shadow-glow-cyan disabled:opacity-40 disabled:cursor-not-allowed transition-all transform hover:scale-[1.02] active:scale-[0.98]"
        >
          {adding ? 'Adding…' : 'Add to practice'}
        </button>
        {addMessage && (
          <p className="mt-2 text-xs text-emerald-300 bg-emerald-950/70 border border-emerald-500/30 rounded-xl px-3 py-1.5 drop-shadow-[0_0_6px_rgb(var(--emerald-400)/0.3)]">{addMessage}</p>
        )}

        <div className="mt-5 pt-4 border-t border-cyan-500/20">
          <h3 className="text-xs font-semibold text-cyan-300 mb-2">
            Your words <span className="font-normal text-cyan-400/60">({customWords.length})</span>
          </h3>
          {customWords.length === 0 ? (
            <p className="text-xs text-slate-400">
              Words you add appear here alongside the ones from your dictation mistakes.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {customWords.map((w) => (
                <li
                  key={w}
                  className="flex items-center justify-between gap-2 text-xs font-mono text-slate-200 bg-abyss-800/80 border border-cyan-500/20 rounded-xl px-2.5 py-1.5 hover:border-cyan-500/40 transition-colors"
                >
                  <span className="truncate">{displayOf(w)}</span>
                  {binnedSet.has(w) && (
                    <span className="text-[10px] font-sans text-cyan-400/60 shrink-0">binned</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  )
}
