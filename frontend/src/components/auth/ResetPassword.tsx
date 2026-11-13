import { FormEvent, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiErrorMessage, resetPassword, setAuthToken } from '../../api'
import { AuthField, AuthLayout, AuthLink, AuthSubmit } from './AuthLayout'
import { MIN_PASSWORD_LENGTH, passwordProblem } from './password'

export default function ResetPassword() {
  const navigate = useNavigate()
  const location = useLocation()
  // The emailed link carries the token in the fragment: /reset-password#token=...
  const [token] = useState(() => new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const footer = <AuthLink to="/login">Back to sign in</AuthLink>

  if (!token) {
    return (
      <AuthLayout title="Reset link not valid" footer={footer}>
        <p className="text-sm text-slate-300">
          This page needs the link from a password reset email.{' '}
          <AuthLink to="/forgot-password">Request a new link</AuthLink>.
        </p>
      </AuthLayout>
    )
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(password, confirm)
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setBusy(true)
    try {
      await resetPassword(token, password)
      // Any session in this browser was signed with the old password.
      setAuthToken(null)
      navigate('/login', {
        replace: true,
        state: { notice: 'Password updated. Sign in with your new password.' },
      })
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not update the password. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Choose a new password"
      error={error}
      footer={
        error ? (
          <>
            <AuthLink to="/forgot-password">Request a new link</AuthLink> · {footer}
          </>
        ) : (
          footer
        )
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthField
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          minLength={MIN_PASSWORD_LENGTH}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <AuthField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <AuthSubmit busy={busy}>{busy ? 'Saving…' : 'Save new password'}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
