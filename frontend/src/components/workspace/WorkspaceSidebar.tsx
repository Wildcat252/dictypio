import { useEffect, useRef, useState } from 'react'
import {
  api,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  removeVideoFromPlaylist,
  deleteVideo,
  getLessonSessions,
  type LessonSessionRecord,
} from '../../api'
import { useWorkspace, type Lesson } from '../../contexts/WorkspaceContext'

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Standard typing-test convention: a "word" is 5 characters. correct_chars counts
// only forward-typed characters that keep the normalized prefix valid
// (DictationArea), so backspace-and-retype is not re-credited -- this is net
// correct keystrokes / 5, deliberately a little below a raw character count.
function computeWpm(correctChars: number, typingMs: number): number | null {
  if (!typingMs || typingMs < 1000 || !correctChars) return null
  const wpm = (correctChars / 5) / (typingMs / 60000)
  if (!Number.isFinite(wpm) || wpm <= 0 || wpm > 300) return null
  return Math.round(wpm)
}

/**
 * Playlist selector and lesson list. Owns playlist/lesson mutations and its own
 * menu state; selecting a lesson is handed back to Workspace because that also
 * resets playback and restores session progress.
 */
export function WorkspaceSidebar({
  mobileSidebarOpen,
  sidebarCollapsed,
  onLessonSelect,
  onOpenImport,
  fetchPlaylists,
  fetchLessons,
  pushNotification,
}: {
  mobileSidebarOpen: boolean
  sidebarCollapsed: boolean
  onLessonSelect: (lesson: Lesson) => void
  onOpenImport: () => void
  fetchPlaylists: () => Promise<void>
  fetchLessons: () => Promise<void>
  pushNotification: (type: 'success' | 'error' | 'info', message: string) => void
}) {
  const {
    playlists,
    selectedPlaylistId,
    setSelectedPlaylistId,
    lessons,
    setLessons,
    selectedLesson,
    setSelectedLesson,
    setSentences,
    setSentencesVideoId,
    videoSessionScores,
  } = useWorkspace()

  const [lessonMenuOpen, setLessonMenuOpen] = useState<number | null>(null)
  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false)
  // undefined = not fetched yet; null = fetched, no session on record.
  const [lessonStats, setLessonStats] = useState<Record<number, LessonSessionRecord | null>>({})

  // Preload most recent lesson history per video to drive sidebar progress bars.
  useEffect(() => {
    if (!lessons.length) return
    const missingIds = lessons
      .map((l) => l.video_id)
      .filter((id) => lessonStats[id] === undefined)
    if (!missingIds.length) return

      ; (async () => {
        await Promise.all(
          missingIds.map(async (videoId) => {
            try {
              const sessions = await getLessonSessions(videoId)
              const latest = (sessions[0] as LessonSessionRecord | undefined) ?? null
              setLessonStats((prev) => (prev[videoId] === undefined ? { ...prev, [videoId]: latest } : prev))
            } catch {
              // ignore per-video errors
            }
          })
        )
      })()
  }, [lessons, lessonStats])

  // The bulk prefetch above caches per video and never refetches, so a lesson
  // you just practiced would keep a stale figure. Refresh both the lesson being
  // opened and the one being left. handleLessonSelect fires its save without
  // awaiting it and the autosave is debounced, so give those a beat to land.
  const prevVideoIdRef = useRef<number | null>(null)
  useEffect(() => {
    const nextId = selectedLesson?.video_id ?? null
    const prevId = prevVideoIdRef.current
    prevVideoIdRef.current = nextId
    const ids = [...new Set([nextId, prevId])].filter((x): x is number => x !== null)
    if (!ids.length) return
    let cancelled = false
    const timer = setTimeout(() => {
      ids.forEach(async (id) => {
        try {
          const sessions = await getLessonSessions(id)
          if (!cancelled) setLessonStats((prev) => ({ ...prev, [id]: sessions[0] ?? null }))
        } catch {
          // ignore per-video errors
        }
      })
    }, 1200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selectedLesson?.video_id])

  const handleNewPlaylist = async () => {
    const name = window.prompt('New playlist name:', 'My Playlist')
    if (!name?.trim()) return
    try {
      const created = await createPlaylist(name.trim())
      await fetchPlaylists()
      setSelectedPlaylistId(created.id)
      pushNotification('success', 'Playlist created.')
    } catch (err) {
      pushNotification('error', 'Failed to create playlist.')
    }
  }

  const handleRenamePlaylist = async () => {
    if (!selectedPlaylistId) return
    const playlist = playlists.find((p) => p.id === selectedPlaylistId)
    const name = window.prompt('Rename playlist:', playlist?.name ?? '')
    if (!name?.trim()) return
    try {
      await updatePlaylist(selectedPlaylistId, name.trim())
      await fetchPlaylists()
      pushNotification('success', 'Playlist renamed.')
    } catch (err) {
      pushNotification('error', 'Failed to rename playlist.')
    }
  }

  const handleDeletePlaylist = async () => {
    if (!selectedPlaylistId) return
    if (!window.confirm('Delete this playlist? Lessons will not be deleted.')) return
    try {
      await deletePlaylist(selectedPlaylistId)
      await fetchPlaylists()
      setSelectedPlaylistId(playlists.length > 1 ? playlists.find((p) => p.id !== selectedPlaylistId)?.id ?? null : null)
      setSelectedLesson(null)
      setLessons([])
      pushNotification('success', 'Playlist deleted.')
    } catch (err) {
      pushNotification('error', 'Failed to delete playlist.')
    }
  }

  const handleRemoveFromPlaylist = async (lesson: Lesson) => {
    if (!selectedPlaylistId) return
    if (!window.confirm(`Remove "${lesson.title}" from this playlist?`)) return
    try {
      await removeVideoFromPlaylist(selectedPlaylistId, lesson.video_id)
      await fetchLessons()
      if (selectedLesson?.video_id === lesson.video_id) {
        setSelectedLesson(null)
        setSentences([])
        setSentencesVideoId(null)
      }
      pushNotification('success', 'Removed from playlist.')
    } catch (err) {
      pushNotification('error', 'Failed to remove.')
    }
    setLessonMenuOpen(null)
  }

  const handleMoveLessonToPlaylist = async (lesson: Lesson, targetPlaylistId: number) => {
    if (!selectedPlaylistId || targetPlaylistId === selectedPlaylistId) return
    try {
      await api.post(`/api/playlists/${targetPlaylistId}/videos/${lesson.video_id}`)
      await removeVideoFromPlaylist(selectedPlaylistId, lesson.video_id)
      await fetchLessons()
      if (selectedLesson?.video_id === lesson.video_id) {
        setSelectedLesson(null)
        setSentences([])
        setSentencesVideoId(null)
      }
      pushNotification('success', 'Lesson moved to playlist.')
    } catch (err) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? null
      pushNotification('error', message || 'Failed to move lesson.')
    } finally {
      setLessonMenuOpen(null)
    }
  }

  const handleDeleteLesson = async (lesson: Lesson) => {
    if (!window.confirm(`Delete "${lesson.title}"? It will be removed from all playlists. Your learning data will be preserved for analysis.`)) return
    try {
      await deleteVideo(lesson.video_id)
      await fetchPlaylists()
      await fetchLessons()
      if (selectedLesson?.video_id === lesson.video_id) {
        setSelectedLesson(null)
        setSentences([])
        setSentencesVideoId(null)
      }
      pushNotification('success', 'Lesson removed. Learning data preserved.')
    } catch (err) {
      pushNotification('error', 'Failed to delete lesson.')
    }
    setLessonMenuOpen(null)
  }

  const handleOpenYoutubeForLesson = (lesson: Lesson) => {
    if (!lesson.youtube_url) {
      pushNotification('error', 'Original YouTube link is not available for this lesson.')
      return
    }
    window.open(lesson.youtube_url, '_blank', 'noopener,noreferrer')
    setLessonMenuOpen(null)
  }

  return (
    <aside
      id="workspace-lessons-sidebar"
      className={`w-full md:w-80 shrink-0 max-md:max-h-[min(55vh,440px)] md:max-h-none bg-abyss-900/95 md:bg-abyss-900/80 backdrop-blur-md border-cyan-500/20 border-b md:border-b-0 md:border-r flex flex-col min-h-0 ${!mobileSidebarOpen ? 'max-md:hidden' : ''
        } ${sidebarCollapsed ? 'md:hidden' : ''}`}
    >
      <div className="p-3.5 border-b border-cyan-500/20">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <select
              value={selectedPlaylistId || ''}
              onChange={(e) => setSelectedPlaylistId(Number(e.target.value))}
              className="w-full appearance-none bg-abyss-800/90 text-slate-100 rounded-lg border border-cyan-500/30 px-3 py-2 pr-8 cursor-pointer hover:border-cyan-400/60 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-transparent text-sm transition-all"
            >
              {playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id} className="bg-abyss-850 text-slate-100">
                  {playlist.name}
                </option>
              ))}
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-cyan-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setPlaylistMenuOpen(!playlistMenuOpen)
              }}
              className="p-2 rounded-lg text-slate-400 hover:bg-abyss-800 hover:text-cyan-300 border border-transparent hover:border-cyan-500/30 focus:outline-none focus:ring-2 focus:ring-cyan-500 transition-colors"
              aria-label="Playlist menu"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
            </button>
            {playlistMenuOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-20 py-1 bg-abyss-850/95 backdrop-blur-md border border-cyan-500/30 rounded-xl shadow-glass-glow text-left min-w-[160px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => {
                    handleNewPlaylist()
                    setPlaylistMenuOpen(false)
                  }}
                  className="block w-full px-3 py-2 text-sm text-slate-200 hover:text-cyan-300 hover:bg-cyan-950/50 text-left transition-colors"
                >
                  New playlist
                </button>
                {selectedPlaylistId && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        handleRenamePlaylist()
                        setPlaylistMenuOpen(false)
                      }}
                      className="block w-full px-3 py-2 text-sm text-slate-200 hover:text-cyan-300 hover:bg-cyan-950/50 text-left transition-colors"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleDeletePlaylist()
                        setPlaylistMenuOpen(false)
                      }}
                      className="block w-full px-3 py-2 text-sm text-rose-400 hover:bg-rose-950/50 text-left transition-colors"
                    >
                      Delete playlist
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {lessons.map((lesson) => {
          const latestSession = lessonStats[lesson.video_id] ?? null
          const practicedSentences = latestSession?.sentences_practiced ?? 0
          const isSelected = selectedLesson?.id === lesson.id
          // The open lesson's stored record lags the debounced autosave, so
          // read its speed from live state instead.
          const wpm = isSelected
            ? computeWpm(videoSessionScores.correctChars, videoSessionScores.typingMs)
            : computeWpm(latestSession?.correct_chars ?? 0, latestSession?.typing_ms ?? 0)
          const totalSentences = lesson.sentence_count || 0
          const progressFraction =
            totalSentences > 0 ? Math.max(0, Math.min(1, practicedSentences / totalSentences)) : 0
          const progressPercent = progressFraction * 100

          return (
            <div
              key={lesson.id}
              className={`relative p-3.5 rounded-xl cursor-pointer transition-all duration-150 group border ${selectedLesson?.id === lesson.id
                ? 'bg-gradient-to-r from-cyan-950/90 via-abyss-800/95 to-sky-950/90 border-cyan-400/60 shadow-glow-cyan text-white'
                : 'bg-abyss-850/60 border-cyan-950/60 hover:border-cyan-500/40 hover:bg-abyss-800/80 text-slate-200'
                }`}
              onClick={() => onLessonSelect(lesson)}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setLessonMenuOpen(lessonMenuOpen === lesson.id ? null : lesson.id)
                }}
                className={`absolute top-2 right-2 p-1 rounded-lg opacity-70 hover:opacity-100 transition-opacity ${selectedLesson?.id === lesson.id ? 'text-cyan-300 hover:bg-abyss-700' : 'text-slate-400 hover:bg-abyss-700'
                  }`}
                aria-label="Lesson menu"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                </svg>
              </button>
              {lessonMenuOpen === lesson.id && (
                <div
                  className="absolute right-2 top-10 z-20 py-1 bg-abyss-850/95 backdrop-blur-md border border-cyan-500/30 rounded-xl shadow-glass-glow text-left min-w-[200px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => handleRemoveFromPlaylist(lesson)}
                    className="block w-full px-3 py-2 text-sm text-slate-200 hover:text-cyan-300 hover:bg-cyan-950/50 text-left transition-colors"
                  >
                    Remove from playlist
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteLesson(lesson)}
                    className="block w-full px-3 py-2 text-sm text-rose-400 hover:bg-rose-950/50 text-left transition-colors"
                  >
                    Delete lesson
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenYoutubeForLesson(lesson)}
                    className="block w-full px-3 py-2 text-sm text-slate-200 hover:text-cyan-300 hover:bg-cyan-950/50 text-left transition-colors"
                  >
                    Open original YouTube
                  </button>
                  <div className="my-1 border-t border-cyan-500/20" />
                  <div className="px-3 py-1 text-[11px] font-semibold text-cyan-400 uppercase tracking-wider">
                    Move to playlist
                  </div>
                  {playlists.filter((p) => p.id !== selectedPlaylistId).length === 0 ? (
                    <div className="px-3 py-1 text-xs text-slate-500">
                      No other playlists
                    </div>
                  ) : (
                    playlists
                      .filter((p) => p.id !== selectedPlaylistId)
                      .map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleMoveLessonToPlaylist(lesson, p.id)}
                          className="block w-full px-3 py-1.5 text-sm text-slate-200 hover:text-cyan-300 hover:bg-cyan-950/50 text-left transition-colors"
                        >
                          {p.name}
                        </button>
                      ))
                  )}
                </div>
              )}
              <div className="space-y-1.5 pr-6">
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className={`text-sm font-semibold leading-snug line-clamp-2 text-left ${selectedLesson?.id === lesson.id ? 'text-white' : 'text-slate-100'
                      }`}
                  >
                    {lesson.title}
                  </h3>
                  {lesson.is_favorite && (
                    <svg className="w-4 h-4 text-amber-400 drop-shadow-[0_0_6px_rgba(251,191,36,0.6)] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  )}
                </div>
                <div
                  className={`flex justify-between gap-2 text-[11px] ${isSelected ? 'text-cyan-200' : 'text-slate-400'
                    }`}
                >
                  <span className="truncate">{formatDuration(lesson.duration)}</span>
                  <span className="whitespace-nowrap">
                    {lesson.sentence_count} sentences
                  </span>
                  <span className="whitespace-nowrap font-medium text-cyan-300" title="Typing speed on your latest session">
                    {wpm !== null ? `${wpm} WPM` : '— WPM'}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full bg-abyss-950 border border-cyan-500/20 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${progressFraction >= 1
                      ? 'bg-gradient-to-r from-teal-400 to-emerald-400 shadow-glow-emerald'
                      : 'bg-gradient-to-r from-cyan-400 to-teal-400 shadow-glow-cyan'
                      }`}
                    style={{ width: `${progressPercent || 0}%` }}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="p-3.5 border-t border-cyan-500/20">
        <button
          onClick={() => onOpenImport()}
          className="w-full bg-gradient-to-r from-cyan-500 via-teal-500 to-sky-600 hover:from-cyan-400 hover:via-teal-400 hover:to-sky-500 text-white font-semibold py-2.5 px-4 rounded-xl shadow-glow-cyan transition-all transform hover:scale-[1.02] active:scale-[0.98]"
        >
          Import Lesson
        </button>
      </div>
    </aside>
  )
}
