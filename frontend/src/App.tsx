import { useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { WorkspaceProvider } from './contexts/WorkspaceContext'
import { startSpeechKeepAlive } from './voices'
import Workspace from './components/Workspace'
import Practice from './components/Practice'
import Dashboard from './components/Dashboard'
import Settings from './components/Settings'
import YouTubeProcessor from './components/YouTubeProcessor'
import Login from './components/auth/Login'
import Register from './components/auth/Register'
import ForgotPassword from './components/auth/ForgotPassword'
import ResetPassword from './components/auth/ResetPassword'
import ConfirmEmail from './components/auth/ConfirmEmail'
import { ProtectedRoute, PublicOnlyRoute } from './components/auth/RouteGuards'

function App() {
  // Chrome cuts speech off after ~15s without this nudge; see voices.ts.
  useEffect(() => startSpeechKeepAlive(), [])

  return (
    <Router>
      <AuthProvider>
        <Routes>
          <Route element={<PublicOnlyRoute />}>
            <Route path="login" element={<Login />} />
            <Route path="register" element={<Register />} />
            <Route path="forgot-password" element={<ForgotPassword />} />
          </Route>
          {/* Reachable signed in or not: an emailed link opens wherever the mail is read. */}
          <Route path="reset-password" element={<ResetPassword />} />
          <Route path="confirm-email" element={<ConfirmEmail />} />
          <Route element={<ProtectedRoute />}>
            <Route
              path="/"
              element={
                <WorkspaceProvider>
                  <Outlet />
                </WorkspaceProvider>
              }
            >
              <Route index element={<Navigate to="/workspace" replace />} />
              <Route path="workspace" element={<Workspace />} />
              <Route path="practice" element={<Practice />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="settings" element={<Settings />} />
              <Route path="youtube" element={<YouTubeProcessor />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/workspace" replace />} />
        </Routes>
      </AuthProvider>
    </Router>
  )
}

export default App
