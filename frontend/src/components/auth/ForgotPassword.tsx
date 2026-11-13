import { FormEvent, useState } from 'react'
import { apiErrorMessage, forgotPassword } from '../../api'
import { AuthField, AuthLayout, AuthLink, AuthSubmit } from './AuthLayout'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await forgotPassword(email.trim())
      setSentTo(email.trim())
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not send the reset email. Please try again.'))
    } finally {
      setBusy(false)
    }
  }

  const footer = <AuthLink to="/login">Back to sign in</AuthLink>

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" footer={footer}>
        <p className="text-sm text-slate-300">
          If <span className="font-medium text-slate-100">{sentTo}</span> has an account, we sent a
          link to reset the password. The link works for 30 minutes.
        </p>
        <p className="mt-3 text-sm text-slate-400">
          Nothing arrived? Check the spam folder, or{' '}
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="text-cyan-300 hover:text-cyan-200 hover:underline"
          >
            try another address
          </button>
          .
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your account email and we'll send you a link to choose a new password."
      error={error}
      footer={footer}
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
        <AuthSubmit busy={busy}>{busy ? 'Sending…' : 'Send reset link'}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
