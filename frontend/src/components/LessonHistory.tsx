import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { AI_COACH_ENABLED } from '../features'
import {
  getLessonSessions,
  getCoachFeedback,
  type LessonSessionRecord,
  type CoachFeedbackResponse,
} from '../api'

function formatDate(d: string): string {
  const date = new Date(d)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(d: string): string {
  return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function groupByDate(sessions: LessonSessionRecord[]): { dateLabel: string; sessions: LessonSessionRecord[] }[] {
  const byDate = new Map<string, LessonSessionRecord[]>()
  for (const s of sessions) {
    const key = new Date(s.started_at).toDateString()
    if (!byDate.has(key)) byDate.set(key, [])
    byDate.get(key)!.push(s)
  }
  const sortedKeys = Array.from(byDate.keys()).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime()
  )
  return sortedKeys.map((key) => ({
    dateLabel: formatDate(new Date(key).toISOString()),
    sessions: byDate.get(key)!,
  }))
}

interface LessonHistoryProps {
  videoId: number | null
  onResume?: (session: LessonSessionRecord) => void
  isLessonFinished?: boolean
}

export default function LessonHistory({ videoId, onResume, isLessonFinished }: LessonHistoryProps) {
  const [sessions, setSessions] = useState<LessonSessionRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [coachOpen, setCoachOpen] = useState(false)
  const [activeSession, setActiveSession] = useState<LessonSessionRecord | null>(null)
  const [coachLoading, setCoachLoading] = useState(false)
  const [coachError, setCoachError] = useState<string | null>(null)
  const [coachFeedback, setCoachFeedback] = useState<CoachFeedbackResponse | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!videoId) {
      setSessions([])
      return
    }
    setLoading(true)
    getLessonSessions(videoId)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [videoId])

  const grouped = groupByDate(sessions)

  const handleAskCoach = (session: LessonSessionRecord) => {
    if (!videoId) return
    setCoachOpen(true)
    setActiveSession(session)
    setCoachLoading(true)
    setCoachError(null)
    setCoachFeedback(null)
    getCoachFeedback({
      video_id: videoId,
      from_date: session.started_at,
      to_date: session.ended_at ?? session.started_at,
    })
      .then((data) => {
        setCoachFeedback(data)
      })
      .catch((e) => {
        const err = e as { response?: { data?: { detail?: string } } }
        setCoachError(
          err.response?.data?.detail ||
            'AI coach is unavailable. Check your AI API key in Settings.'
        )
      })
      .finally(() => setCoachLoading(false))
  }

  return (
    <div className="fixed bottom-6 right-3 left-3 md:left-auto md:bottom-8 md:right-4 z-40 flex flex-col items-stretch md:items-end space-y-2">
      {coachOpen && (
        <div className="w-full max-w-sm md:w-80 max-h-[60vh] overflow-hidden rounded-2xl border border-cyan-500/30 bg-abyss-900/95 backdrop-blur-xl shadow-glass-glow flex flex-col text-slate-100">
          <div className="px-3.5 py-2.5 border-b border-cyan-500/20 flex items-center justify-between bg-abyss-850/60">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-teal-200 truncate">Ask coach about session</h2>
              {activeSession && (
                <p className="text-[11px] text-cyan-400/80">
                  {formatDate(activeSession.started_at)} · {formatTime(activeSession.started_at)}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCoachOpen(false)}
              className="p-1 rounded-lg text-slate-400 hover:bg-abyss-800 hover:text-cyan-300 border border-transparent hover:border-cyan-500/30 transition-colors"
              aria-label="Close coach panel"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="px-3.5 py-2 text-xs text-slate-400 border-b border-cyan-500/15 bg-abyss-950/40">
            Feedback is based on your overall stats; date filters may be used in future versions.
          </div>
          <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3 text-sm">
            {coachError && (
              <div className="text-sm text-rose-300 bg-rose-950/70 border border-rose-500/30 px-3 py-2 rounded-xl">
                {coachError}{' '}
                <button
                  type="button"
                  onClick={() => navigate('/settings')}
                  className="underline font-semibold text-rose-200"
                >
                  Open AI settings
                </button>
              </div>
            )}
            {coachLoading && !coachFeedback && !coachError && (
              <p className="text-sm text-cyan-300 animate-pulse">Asking your AI coach…</p>
            )}
            {coachFeedback && (
              <>
                <p className="text-sm text-slate-200 whitespace-pre-line leading-relaxed">
                  {coachFeedback.summary}
                </p>
                {coachFeedback.suggestions?.length > 0 && (
                  <ul className="space-y-2">
                    {coachFeedback.suggestions.map((s, i) => (
                      <li key={i} className="flex gap-2 text-sm text-slate-200">
                        <span className="mt-0.5 w-4 h-4 rounded-full bg-cyan-950 border border-cyan-500/40 text-cyan-300 flex items-center justify-center text-[10px] font-bold shrink-0 shadow-glow-cyan">
                          {i + 1}
                        </span>
                        <span className="leading-snug">{s}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {!coachLoading && !coachFeedback && !coachError && (
              <p className="text-sm text-slate-400">
                Connect an AI key in Settings and choose &ldquo;Ask coach&rdquo; on a session to see
                personalized tips.
              </p>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-xl bg-abyss-800/90 border border-cyan-500/30 text-cyan-300 hover:text-cyan-200 hover:bg-abyss-750 hover:border-cyan-400/60 px-3.5 py-2 text-xs font-semibold shadow-glow-cyan backdrop-blur-md transition-all self-end md:self-auto"
      >
        {open ? 'Hide History' : 'Lesson History'}
      </button>
      {open && (
        <div className="mt-1 w-full max-w-sm md:w-80 max-h-[min(60vh,400px)] overflow-hidden rounded-2xl border border-cyan-500/30 bg-abyss-900/95 backdrop-blur-xl shadow-glass-glow flex flex-col text-slate-100">
          <div className="p-3 border-b border-cyan-500/20 font-bold text-sm shrink-0 bg-abyss-850/60 bg-gradient-to-r from-cyan-300 to-teal-200 bg-clip-text text-transparent">
            Lesson history
          </div>
          <div className="overflow-y-auto flex-1 p-2.5 space-y-3">
            {loading ? (
              <div className="text-cyan-300 text-sm py-4 text-center animate-pulse">Loading…</div>
            ) : !videoId ? (
              <div className="text-slate-400 text-sm py-4 text-center">Select a lesson</div>
            ) : grouped.length === 0 ? (
              <div className="text-slate-400 text-sm py-4 text-center">No history yet</div>
            ) : (
              <div className="space-y-3.5">
                {grouped.map(({ dateLabel, sessions: daySessions }) => (
                  <div key={dateLabel}>
                    <div className="text-[11px] font-semibold text-cyan-400/90 uppercase tracking-wider mb-1.5 px-1">
                      {dateLabel}
                    </div>
                    <ul className="space-y-2">
                      {daySessions.map((s) => (
                        <li
                          key={s.id}
                          className="text-sm border border-cyan-500/20 rounded-xl p-2.5 bg-abyss-800/60 hover:border-cyan-400/40 transition-all"
                        >
                          <div className="flex justify-between items-center text-slate-400">
                            <span className="text-xs font-mono font-medium text-slate-300">
                              {formatTime(s.started_at)}
                            </span>
                            <div className="flex items-center gap-1.5">
                              {onResume && (
                                <button
                                  type="button"
                                  onClick={() => onResume?.(s)}
                                  className="inline-flex items-center rounded-full border border-cyan-400/40 bg-cyan-950/60 px-2 py-0.5 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-900/60 hover:text-white transition-colors"
                                >
                                  <span className="mr-1">↺</span>
                                  Resume
                                </button>
                              )}
                              {AI_COACH_ENABLED && isLessonFinished && (
                                <button
                                  type="button"
                                  onClick={() => handleAskCoach(s)}
                                  className="inline-flex items-center rounded-full border border-teal-400/40 bg-teal-950/60 px-2 py-0.5 text-[11px] font-semibold text-teal-300 hover:bg-teal-900/60 hover:text-white transition-colors"
                                >
                                  Ask coach
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex mt-1.5 text-slate-200 text-xs">
                            Practiced sentences: <strong className="ml-1 text-cyan-300">{s.sentences_practiced}</strong>
                          </div>
                          <div className="flex mt-1.5 text-xs justify-between font-mono">
                            <span className="text-emerald-400">Correct: {s.correct_chars}</span>
                            <span className="text-amber-400">Hints: {s.hint_count}</span>
                            <span className="text-rose-400">Incorrect: {s.incorrect_chars}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
