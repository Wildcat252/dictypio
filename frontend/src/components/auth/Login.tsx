import { FormEvent, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { clearSignedOutNotice, readSignedOutNotice } from '../../accountStorage'
import { apiErrorMessage } from '../../api'
import { useAuth } from '../../contexts/AuthContext'
import { AuthField, AuthLayout, AuthLink, AuthSubmit } from './AuthLayout'

export default function Login() {
  const { login } = useAuth()
  const location = useLocation()
  // From ResetPassword after a successful reset, or left behind by a sign-out
  // that had something to say (the account was deleted).
  const [notice] = useState(
    () => (location.state as { notice?: string } | null)?.notice ?? readSignedOutNotice()
  )
  useEffect(clearSignedOutNotice, [])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // On success PublicOnlyRoute sees the user and leaves this page.
      await login(email.trim(), password)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not sign in. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      error={error}
      notice={error ? null : notice}
      footer={
        <>
          New here? <AuthLink to="/register">Create an account</AuthLink>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthField
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <AuthField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          labelAside={
            <span className="text-xs">
              <AuthLink to="/forgot-password">Forgot password?</AuthLink>
            </span>
          }
        />
        <AuthSubmit busy={busy}>{busy ? 'Signing in…' : 'Sign in'}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
