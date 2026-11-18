import { useRef, useState } from 'react'
import axios from 'axios'
import { api, waitForServer } from '../../api'
import { useWorkspace, type Lesson, type Sentence } from '../../contexts/WorkspaceContext'
import { TRICKY_LESSON_ID, fetchTrickySentences, isTrickyLesson } from './trickyLesson'

export interface Notification {
  id: string
  type: 'success' | 'error' | 'info'
  message: string
}

/**
 * Lesson/playlist data loading, background import, and the transient
 * notification toasts they raise. Playback orchestration stays in Workspace.
 *
 * Answers can arrive late and out of order (a slow or waking server, quick
 * clicks), so each fetch checks on arrival that it is still the one wanted,
 * through refs that always hold the current selection.
 */
export function useLessonData() {
  const {
    setPlaylists,
    selectedPlaylistId,
    setSelectedPlaylistId,
    selectedLesson,
    setSelectedLesson,
    lessons,
    setLessons,
    setSentences,
    setSentencesVideoId,
  } = useWorkspace()

  const [notifications, setNotifications] = useState<Notification[]>([])
  const [isImportInProgress, setIsImportInProgress] = useState(false)

  const selectedPlaylistIdRef = useRef(selectedPlaylistId)
  selectedPlaylistIdRef.current = selectedPlaylistId
  const selectedLessonRef = useRef(selectedLesson)
  selectedLessonRef.current = selectedLesson
  const lessonsRef = useRef(lessons)
  lessonsRef.current = lessons
  /** The lesson whose sentences were asked for last; older answers are dropped. */
  const wantedSentencesRef = useRef<number | null>(null)
  const sentencesInFlightRef = useRef<{ videoId: number; promise: Promise<Sentence[]> } | null>(null)
  const sentencesFailedForRef = useRef<number | null>(null)

  const pushNotification = (type: Notification['type'], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setNotifications((prev) => [...prev, { id, type, message }])
    setTimeout(() => {
      setNotifications((prev) => prev.filter((note) => note.id !== id))
    }, 5000)
  }

  const fetchPlaylists = async () => {
    try {
      const response = await api.get('/api/playlists')
      setPlaylists(response.data)
      const current = selectedPlaylistIdRef.current
      if (response.data.length > 0) {
        // The saved selection may be a playlist deleted since (on another device).
        if (!response.data.some((p: { id: number }) => p.id === current)) {
          setSelectedPlaylistId(response.data[0].id)
        }
      } else {
        // Create default playlist if none exists
        const defaultPlaylist = await api.post('/api/playlists', {
          name: 'Default Playlist'
        })
        setPlaylists([defaultPlaylist.data])
        setSelectedPlaylistId(defaultPlaylist.data.id)
      }
    } catch (err) {
      console.error('Error fetching playlists:', err)
    }
  }

  const fetchLessons = async () => {
    const playlistId = selectedPlaylistIdRef.current
    if (!playlistId) return

    try {
      const response = await api.get(`/api/playlists/${playlistId}/videos`)
      // Another playlist was picked while this one loaded.
      if (selectedPlaylistIdRef.current !== playlistId) return
      const videos: Lesson[] = response.data.map((item: {
        id: number
        video_id: number
        title?: string
        duration?: number
        sentence_count?: number
        audio_file_path?: string
        youtube_url?: string
      }) => ({
        id: item.id,
        video_id: item.video_id,
        title: item.title || 'Untitled Video',
        duration: item.duration || 0,
        sentence_count: item.sentence_count || 0,
        audio_file_path: item.audio_file_path,
        youtube_url: item.youtube_url,
        is_favorite: false
      }))
      setLessons(videos)
      if (videos.length > 0 && !selectedLessonRef.current) {
        setSelectedLesson(videos[0])
      }
    } catch (err) {
      console.error('Error fetching lessons:', err)
    }
  }

  /**
   * Check the lesson restored from this device's saved state against the
   * server: it may have been deleted elsewhere, or its audio may have changed
   * (lost, or restored by importing it again).
   */
  const revalidateSelectedLesson = async () => {
    const lesson = selectedLessonRef.current
    if (!lesson || isTrickyLesson(lesson)) return
    if (!(await waitForServer())) return
    try {
      const { data } = await api.get(`/api/youtube/videos/${lesson.video_id}`)
      const current = selectedLessonRef.current
      if (!current || current.video_id !== lesson.video_id) return
      const fresh = {
        title: data.title || current.title,
        duration: data.duration ?? current.duration,
        audio_file_path: data.audio_file_path ?? undefined,
        youtube_url: data.youtube_url ?? current.youtube_url,
      }
      const changed = (Object.keys(fresh) as (keyof typeof fresh)[]).some((k) => fresh[k] !== current[k])
      if (changed) setSelectedLesson({ ...current, ...fresh })
    } catch (err) {
      if (!axios.isAxiosError(err) || err.response?.status !== 404) return
      const current = selectedLessonRef.current
      if (!current || current.video_id !== lesson.video_id) return
      // Gone: open another lesson of the playlist instead of a dead one.
      const next = lessonsRef.current.find((l) => l.video_id !== lesson.video_id) ?? null
      selectedLessonRef.current = next
      setSelectedLesson(next)
      setSentences([])
      setSentencesVideoId(null)
    }
  }


  const runImportInBackground = async (payload: { playlistId: number; url?: string; title?: string; text?: string }) => {
    setIsImportInProgress(true)
    try {
      let videoId: number
      let message: string | undefined
      if (payload.url) {
        const processResponse = await api.post('/api/youtube/process', {
          url: payload.url
        })
        videoId = processResponse.data.video_id
        message = processResponse.data.message
      } else {
        const processResponse = await api.post('/api/youtube/process_text', {
          title: payload.title,
          text: payload.text
        })
        videoId = processResponse.data.video_id
      }
      await api.post(`/api/playlists/${payload.playlistId}/videos/${videoId}`)
      pushNotification(
        'success',
        message === 'Audio restored'
          ? 'Audio restored. The lesson plays again, with your progress kept.'
          : 'Import complete. Lesson added to playlist.'
      )
      await fetchPlaylists()
      // The playlist selected now, not the one selected when the import began.
      if (selectedPlaylistIdRef.current === payload.playlistId) {
        await fetchLessons()
      }
      // The open lesson may be the one whose audio just came back.
      if (selectedLessonRef.current?.video_id === videoId) {
        await revalidateSelectedLesson()
      }
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? null
      pushNotification(
        'error',
        message || (axios.isAxiosError(err) && !err.response
          ? "Can't reach the server. The import may still finish; check the playlist in a minute."
          : 'Import failed. Please try again.')
      )
    } finally {
      setIsImportInProgress(false)
    }
  }

  const loadSentences = async (videoId: number): Promise<Sentence[]> => {
    if (videoId === TRICKY_LESSON_ID) return fetchTrickySentences()
    const response = await api.get(`/api/youtube/videos/${videoId}/sentences`)
    return response.data as Sentence[]
  }

  /**
   * Load a lesson's sentences into the workspace and return them. A lesson
   * already being fetched shares that request. An answer for a lesson that is
   * no longer wanted is returned to its caller but not shown.
   */
  const fetchSentences = async (videoId: number): Promise<Sentence[]> => {
    wantedSentencesRef.current = videoId
    const inFlight = sentencesInFlightRef.current
    const promise = inFlight && inFlight.videoId === videoId ? inFlight.promise : loadSentences(videoId)
    sentencesInFlightRef.current = { videoId, promise }
    try {
      const data = await promise
      if (wantedSentencesRef.current === videoId) {
        sentencesFailedForRef.current = null
        setSentences(data)
        setSentencesVideoId(videoId)
      }
      return data
    } catch (err) {
      console.error('Error fetching sentences:', err)
      if (wantedSentencesRef.current === videoId) {
        // Never leave another lesson's sentences under this one's title.
        setSentences([])
        setSentencesVideoId(null)
        if (sentencesFailedForRef.current !== videoId) {
          sentencesFailedForRef.current = videoId
          pushNotification('error', "Couldn't load this lesson's sentences. Reopen the lesson to try again.")
        }
      }
      return []
    } finally {
      if (sentencesInFlightRef.current?.promise === promise) sentencesInFlightRef.current = null
    }
  }

  return {
    notifications,
    isImportInProgress,
    pushNotification,
    fetchPlaylists,
    fetchLessons,
    fetchSentences,
    revalidateSelectedLesson,
    runImportInBackground,
  }
}
