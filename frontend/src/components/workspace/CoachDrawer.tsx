import { useEffect, useImperativeHandle, useState, forwardRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getCoachFeedback,
  getCoachRecommendations,
  type CoachFeedbackResponse,
  type PracticeRecommendationItem,
} from '../../api'
import { useWorkspace } from '../../contexts/WorkspaceContext'

export interface CoachDrawerHandle {
  /** Open the drawer and load feedback for a video (used by the "Ask coach" button). */
  openForVideo: (videoId: number | null) => void
}

/**
 * AI coach side panel: lesson recap and practice recommendations. Owns its own
 * state; opens automatically when a lesson is finished, or on demand via the
 * imperative handle.
 */
export const CoachDrawer = forwardRef<CoachDrawerHandle, { isLessonFinished: boolean }>(
  function CoachDrawer({ isLessonFinished }, ref) {
    const navigate = useNavigate()
    const { selectedLesson } = useWorkspace()

    const [coachPanelOpen, setCoachPanelOpen] = useState(false)
    const [coachLoading, setCoachLoading] = useState(false)
    const [coachError, setCoachError] = useState<string | null>(null)
    const [coachFeedback, setCoachFeedback] = useState<CoachFeedbackResponse | null>(null)
    const [practiceLoading, setPracticeLoading] = useState(false)
    const [practiceError, setPracticeError] = useState<string | null>(null)
    const [practiceRecommendations, setPracticeRecommendations] = useState<
      PracticeRecommendationItem[] | null
    >(null)
    const [coachShownForVideoId, setCoachShownForVideoId] = useState<number | null>(null)

    const loadCoachFeedbackForVideo = (videoId: number | null) => {
      if (!videoId) return
      setCoachLoading(true)
      setCoachError(null)
      setCoachPanelOpen(true)
      getCoachFeedback({ video_id: videoId })
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

    const loadPracticeRecommendationsForVideo = (videoId: number | null) => {
      if (!videoId) return
      setPracticeLoading(true)
      setPracticeError(null)
      getCoachRecommendations({ video_id: videoId, limit: 6 })
        .then((data) => {
          setPracticeRecommendations(data.recommendations ?? [])
        })
        .catch((e) => {
          const err = e as { response?: { data?: { detail?: string } } }
          setPracticeError(
            err.response?.data?.detail ||
            'Practice recommendations are temporarily unavailable. Try again later.'
          )
        })
        .finally(() => setPracticeLoading(false))
    }

    useEffect(() => {
      const videoId = selectedLesson?.video_id ?? null
      // Coach feedback is per real video; the virtual tricky lesson (id < 0) has none
      if (!videoId || videoId < 0 || !isLessonFinished) return
      if (coachShownForVideoId === videoId) return
      setCoachShownForVideoId(videoId)
      setCoachLoading(true)
      setCoachError(null)
      setCoachPanelOpen(true)
      getCoachFeedback({ video_id: videoId })
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
    }, [selectedLesson?.video_id, isLessonFinished, coachShownForVideoId])
    useImperativeHandle(ref, () => ({ openForVideo: loadCoachFeedbackForVideo }))

    if (!coachPanelOpen) return null

    return (
      <div className="fixed inset-x-3 bottom-20 md:inset-x-auto md:right-4 md:bottom-24 z-50 w-auto md:w-[28rem] max-h-[min(65vh,520px)] md:max-h-[70vh] rounded-2xl border border-cyan-500/30 bg-abyss-900/95 backdrop-blur-xl shadow-glass-glow flex flex-col text-left text-slate-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-cyan-500/20 flex items-center justify-between bg-abyss-850/60">
          <div>
            <h2 className="text-sm font-bold bg-gradient-to-r from-cyan-300 to-teal-200 bg-clip-text text-transparent">Session recap by AI coach</h2>
            {selectedLesson && (
              <p className="text-[11px] text-cyan-400/80 truncate">
                {selectedLesson.title}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCoachPanelOpen(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-abyss-800 hover:text-cyan-300 border border-transparent hover:border-cyan-500/30 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-slate-400 border-b border-cyan-500/15 bg-abyss-950/40 text-left">
          AI feedback based on your current practice stats for this video.
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3.5 text-sm text-left">
          {coachError && (
            <div className="text-sm text-rose-300 bg-rose-950/70 border border-rose-500/30 px-3.5 py-2.5 rounded-xl shadow-glow-rose">
              {coachError}{' '}
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="underline font-semibold text-rose-200 hover:text-rose-100"
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
                <ul className="space-y-2.5">
                  {coachFeedback.suggestions.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-slate-200">
                      <span className="mt-0.5 w-5 h-5 rounded-full bg-cyan-950 border border-cyan-500/40 text-cyan-300 flex items-center justify-center text-[10px] font-bold shrink-0 shadow-glow-cyan">
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
              Connect an AI key in Settings and click &ldquo;Ask coach&rdquo; to see personalized
              tips for this session.
            </p>
          )}
          <div className="pt-3 border-t border-cyan-500/20 space-y-2">
            <button
              type="button"
              disabled={!selectedLesson || coachLoading}
              onClick={() => selectedLesson && loadCoachFeedbackForVideo(selectedLesson.video_id)}
              className="w-full inline-flex items-center justify-center rounded-xl border border-cyan-500/30 bg-abyss-800/80 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:text-cyan-300 hover:bg-abyss-750 hover:border-cyan-400/50 disabled:opacity-40 transition-all"
            >
              {coachLoading ? 'Refreshing…' : 'Refresh recap'}
            </button>
            <button
              type="button"
              disabled={!selectedLesson || practiceLoading}
              onClick={() =>
                selectedLesson && loadPracticeRecommendationsForVideo(selectedLesson.video_id)
              }
              className="w-full inline-flex items-center justify-center rounded-xl border border-cyan-400/50 bg-gradient-to-r from-cyan-950/80 to-teal-950/80 px-3.5 py-2 text-xs font-semibold text-cyan-300 hover:text-white shadow-glow-cyan disabled:opacity-40 transition-all"
            >
              {practiceLoading ? 'Finding practice sentences…' : 'View practice recommendations'}
            </button>
            {practiceError && (
              <div className="text-xs text-rose-300 bg-rose-950/60 border border-rose-500/30 px-3 py-2 rounded-xl">
                {practiceError}
              </div>
            )}
            {practiceRecommendations && practiceRecommendations.length > 0 && (
              <div className="space-y-2.5 pt-1">
                {practiceRecommendations.map((rec) => (
                  <div
                    key={`${rec.video_id}-${rec.sentence_id}-${rec.start_time}`}
                    className="border border-cyan-500/20 rounded-xl px-3 py-2.5 bg-abyss-800/70 hover:border-cyan-400/40 transition-all"
                  >
                    <div className="text-xs font-semibold text-slate-100 line-clamp-2">
                      {rec.sentence_text}
                    </div>
                    <div className="mt-1 flex justify-between items-center text-[11px] text-slate-400">
                      <span className="truncate text-cyan-400/90">
                        {rec.video_title || 'Video'} · {Math.round(rec.start_time)}s–
                        {Math.round(rec.end_time)}s
                      </span>
                      <span className="ml-2 text-[10px] font-mono text-teal-300 bg-teal-950/60 border border-teal-500/30 px-2 py-0.5 rounded-full">
                        Score {rec.score.toFixed(2)}
                      </span>
                    </div>
                    {rec.reasons?.length > 0 && (
                      <ul className="mt-1.5 text-[11px] text-slate-300 list-disc list-inside space-y-0.5">
                        {rec.reasons.map((r, idx) => (
                          <li key={idx}>{r}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
)
