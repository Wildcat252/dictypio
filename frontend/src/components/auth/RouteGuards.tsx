import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

// Same backdrop as the app, so there is no flash while the session is checked.
// If that takes a while the server is waking up, so say so rather than sit blank.
function Splash({ waking }: { waking: boolean }) {
  return (
    <div
      className="min-h-dvh bg-abyss-900 flex items-center justify-center px-6 text-center"
      aria-busy="true"
    >
      {waking && (
        <div role="status" className="flex flex-col items-center gap-3 text-slate-300">
          <div className="h-8 w-8 rounded-full border-2 border-cyan-500/30 border-t-cyan-400 animate-spin" />
          <p className="text-sm">Waking up the server… this can take up to a minute.</p>
        </div>
      )}
    </div>
  )
}

/** The app itself: needs a signed-in user when accounts are enabled. */
export function ProtectedRoute() {
  const { authEnabled, user, loading, serverWaking } = useAuth()
  if (loading) return <Splash waking={serverWaking} />
  if (authEnabled && !user) return <Navigate to="/login" replace />
  return <Outlet />
}

/** Sign-in and sign-up pages: pointless once signed in, or when accounts are off. */
export function PublicOnlyRoute() {
  const { authEnabled, user, loading, serverWaking } = useAuth()
  if (loading) return <Splash waking={serverWaking} />
  if (!authEnabled || user) return <Navigate to="/workspace" replace />
  return <Outlet />
}
