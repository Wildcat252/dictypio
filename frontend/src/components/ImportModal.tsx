import { useState, useEffect } from 'react'
import { api } from '../api'

interface Playlist {
  id: number
  name: string
  created_at: string
  video_count: number
}

interface ImportModalProps {
  isOpen: boolean
  onClose: () => void
  onImport: (payload: { playlistId: number; url?: string; title?: string; text?: string }) => void
  defaultPlaylistId?: number | null
}

export default function ImportModal({ isOpen, onClose, onImport, defaultPlaylistId }: ImportModalProps) {
  const [importType, setImportType] = useState<'youtube' | 'text'>('youtube')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [textTitle, setTextTitle] = useState('')
  const [textContent, setTextContent] = useState('')
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      fetchPlaylists()
      setYoutubeUrl('')
      setTextTitle('')
      setTextContent('')
      setImportType('youtube')
      setSelectedPlaylistId(defaultPlaylistId || null)
      setNewPlaylistName('')
      setError(null)
    }
  }, [isOpen, defaultPlaylistId])

  const fetchPlaylists = async () => {
    try {
      const response = await api.get('/api/playlists')
      setPlaylists(response.data)
      if (response.data.length > 0 && !selectedPlaylistId) {
        setSelectedPlaylistId(defaultPlaylistId || response.data[0].id)
      }
    } catch (err) {
      console.error('Error fetching playlists:', err)
    }
  }

  const handleCreatePlaylist = async () => {
    if (!newPlaylistName.trim()) {
      setError('Please enter a playlist name')
      return
    }

    setIsCreatingPlaylist(true)
    setError(null)

    try {
      const response = await api.post('/api/playlists', {
        name: newPlaylistName.trim()
      })
      await fetchPlaylists()
      setSelectedPlaylistId(response.data.id)
      setNewPlaylistName('')
      setIsCreatingPlaylist(false)
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? null
      setError(message || 'Failed to create playlist')
      setIsCreatingPlaylist(false)
    }
  }

  const handleImport = () => {
    if (!selectedPlaylistId) {
      setError('Please select or create a playlist')
      return
    }

    if (importType === 'youtube') {
      if (!youtubeUrl.trim()) {
        setError('Please enter a YouTube URL')
        return
      }
      setError(null)
      onImport({ url: youtubeUrl.trim(), playlistId: selectedPlaylistId })
    } else {
      if (!textTitle.trim()) {
        setError('Please enter a title')
        return
      }
      if (!textContent.trim()) {
        setError('Please enter paragraph content')
        return
      }
      setError(null)
      onImport({
        title: textTitle.trim(),
        text: textContent.trim(),
        playlistId: selectedPlaylistId
      })
    }
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-abyss-900/95 backdrop-blur-xl rounded-2xl border border-cyan-500/30 shadow-[0_0_60px_rgb(var(--abyss-950)/0.55),0_0_25px_rgb(var(--ocean-cyan)/0.2)] max-w-md w-full max-h-[90vh] overflow-y-auto text-slate-100">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold bg-gradient-to-r from-cyan-300 via-teal-200 to-sky-300 bg-clip-text text-transparent">Import Lesson</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-abyss-800 hover:text-cyan-300 border border-transparent hover:border-cyan-500/30 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <>
            {/* Import Type Tabs */}
            <div className="flex border-b border-cyan-500/20 mb-6">
              <button
                type="button"
                className={`flex-1 pb-2.5 text-center font-semibold text-sm transition-all ${
                  importType === 'youtube'
                    ? 'border-b-2 border-cyan-400 text-cyan-300 drop-shadow-[0_0_8px_rgb(var(--cyan-400)/0.5)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setImportType('youtube')}
              >
                YouTube Video
              </button>
              <button
                type="button"
                className={`flex-1 pb-2.5 text-center font-semibold text-sm transition-all ${
                  importType === 'text'
                    ? 'border-b-2 border-cyan-400 text-cyan-300 drop-shadow-[0_0_8px_rgb(var(--cyan-400)/0.5)]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                onClick={() => setImportType('text')}
              >
                Custom Text (TTS)
              </button>
            </div>

            {/* YouTube URL Input */}
            {importType === 'youtube' ? (
              <div className="mb-6">
                <label htmlFor="youtube-url" className="block text-sm font-semibold text-cyan-300 mb-2">
                  YouTube URL
                </label>
                <input
                  id="youtube-url"
                  type="text"
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="w-full px-4 py-2.5 bg-abyss-800/90 border-2 border-cyan-500/30 text-slate-100 placeholder:text-slate-500 rounded-xl focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40 transition-all"
                />
              </div>
            ) : (
              <>
                <div className="mb-4">
                  <label htmlFor="text-title" className="block text-sm font-semibold text-cyan-300 mb-2">
                    Title
                  </label>
                  <input
                    id="text-title"
                    type="text"
                    value={textTitle}
                    onChange={(e) => setTextTitle(e.target.value)}
                    placeholder="Enter a title for this lesson..."
                    className="w-full px-4 py-2.5 bg-abyss-800/90 border-2 border-cyan-500/30 text-slate-100 placeholder:text-slate-500 rounded-xl focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40 transition-all"
                  />
                </div>
                <div className="mb-6">
                  <label htmlFor="text-content" className="block text-sm font-semibold text-cyan-300 mb-2">
                    Paragraph Content
                  </label>
                  <textarea
                    id="text-content"
                    rows={4}
                    value={textContent}
                    onChange={(e) => setTextContent(e.target.value)}
                    placeholder="Paste the paragraph text to practice..."
                    className="w-full px-4 py-2.5 bg-abyss-800/90 border-2 border-cyan-500/30 text-slate-100 placeholder:text-slate-500 rounded-xl focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40 resize-none transition-all"
                  />
                </div>
              </>
            )}

            {/* Playlist Selection */}
            <div className="mb-6">
              <label className="block text-sm font-semibold text-cyan-300 mb-2">
                Select Playlist
              </label>

              {/* Existing Playlists */}
              <div className="space-y-2 mb-4">
                {playlists.map((playlist) => (
                  <label
                    key={playlist.id}
                    className={`flex items-center p-3 border rounded-xl cursor-pointer transition-all ${
                      selectedPlaylistId === playlist.id
                        ? 'border-cyan-400/70 bg-cyan-950/60 shadow-glow-cyan'
                        : 'border-cyan-500/20 bg-abyss-800/50 hover:border-cyan-500/40 hover:bg-abyss-800/80'
                    }`}
                  >
                    <input
                      type="radio"
                      name="playlist"
                      value={playlist.id}
                      checked={selectedPlaylistId === playlist.id}
                      onChange={() => setSelectedPlaylistId(playlist.id)}
                      className="mr-3 accent-cyan-400"
                    />
                    <div className="flex flex-row items-center w-full justify-between pl-2 pr-1 sm:px-6">
                      <div className="text-sm font-medium text-slate-100">{playlist.name}</div>
                      <div className="text-xs text-cyan-400/80 font-mono">{playlist.video_count} videos</div>
                    </div>
                  </label>
                ))}
              </div>

              {/* Create New Playlist */}
              <div className="border-t border-cyan-500/20 pt-4">
                <label className="block text-sm font-semibold text-cyan-300 mb-2">
                  Or Create New Playlist
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    placeholder="Enter playlist name..."
                    className="flex-1 px-4 py-2.5 bg-abyss-800/90 border-2 border-cyan-500/30 text-slate-100 placeholder:text-slate-500 rounded-xl focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/40 transition-all"
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        handleCreatePlaylist()
                      }
                    }}
                  />
                  <button
                    onClick={handleCreatePlaylist}
                    disabled={isCreatingPlaylist || !newPlaylistName.trim()}
                    className="px-4 py-2.5 bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl shadow-glow-cyan transition-all"
                  >
                    {isCreatingPlaylist ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="mb-4 bg-rose-950/70 border border-rose-500/40 rounded-xl p-3.5">
                <p className="text-sm text-rose-300">{error}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 border border-cyan-500/30 bg-abyss-800/80 text-slate-200 font-semibold rounded-xl hover:text-cyan-300 hover:border-cyan-400/60 hover:bg-abyss-750 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={
                  importType === 'youtube'
                    ? !youtubeUrl.trim() || !selectedPlaylistId
                    : !textTitle.trim() || !textContent.trim() || !selectedPlaylistId
                }
                className="flex-1 px-4 py-2.5 bg-gradient-to-r from-cyan-500 via-teal-500 to-sky-600 hover:from-cyan-400 hover:via-teal-400 hover:to-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold rounded-xl shadow-glow-cyan transition-all transform hover:scale-[1.02] active:scale-[0.98]"
              >
                Import
              </button>
            </div>
          </>
        </div>
      </div>
    </div>
  )
}
