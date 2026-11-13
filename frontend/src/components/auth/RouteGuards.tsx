import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

// Same backdrop as the app, so there is no flash while the session is checked.
const BLANK = <div className="min-h-screen bg-abyss-900" aria-busy="true" />

/** The app itself: needs a signed-in user when accounts are enabled. */
export function ProtectedRoute() {
  const { authEnabled, user, loading } = useAuth()
  if (loading) return BLANK
  if (authEnabled && !user) return <Navigate to="/login" replace />
  return <Outlet />
}

/** Sign-in and sign-up pages: pointless once signed in, or when accounts are off. */
export function PublicOnlyRoute() {
  const { authEnabled, user, loading } = useAuth()
  if (loading) return BLANK
  if (!authEnabled || user) return <Navigate to="/workspace" replace />
  return <Outlet />
}
