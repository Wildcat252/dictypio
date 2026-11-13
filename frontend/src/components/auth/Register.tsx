import { FormEvent, useState } from 'react'
import { apiErrorMessage } from '../../api'
import { useAuth } from '../../contexts/AuthContext'
import { AuthField, AuthLayout, AuthLink, AuthSubmit } from './AuthLayout'
import { MIN_PASSWORD_LENGTH, passwordProblem } from './password'

export default function Register() {
  const { register } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      // On success PublicOnlyRoute sees the user and leaves this page.
      await register(email.trim(), password)
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the account. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      error={error}
      footer={
        <>
          Already have an account? <AuthLink to="/login">Sign in</AuthLink>
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
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <AuthField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <AuthSubmit busy={busy}>{busy ? 'Creating account…' : 'Create account'}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
