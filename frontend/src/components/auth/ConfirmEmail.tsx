import { FormEvent, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { apiErrorMessage, confirmEmailChange } from '../../api'
import { useAuth } from '../../contexts/AuthContext'
import { AuthLayout, AuthLink, AuthSubmit } from './AuthLayout'

/** Landing page for the link mailed to a new address by Settings → Account → Email. */
export default function ConfirmEmail() {
  const location = useLocation()
  const { authEnabled, user, refreshUser } = useAuth()
  // The emailed link carries the token in the fragment: /confirm-email#token=...
  const [token] = useState(() => new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '')
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The link is opened wherever the mail is read, which may not be signed in.
  const onward = user || !authEnabled ? (
    <AuthLink to="/workspace">Back to Dictypio</AuthLink>
  ) : (
    <AuthLink to="/login">Go to sign in</AuthLink>
  )

  if (!token) {
    return (
      <AuthLayout title="Confirmation link not valid" footer={onward}>
        <p className="text-sm text-slate-300">
          This page needs the link from the confirmation email. To get a new one, change your email
          again under Settings → Account.
        </p>
      </AuthLayout>
    )
  }

  if (confirmedEmail) {
    return (
      <AuthLayout title="Email updated" footer={onward}>
        <p className="text-sm text-slate-300">
          You now sign in with <span className="font-medium text-slate-100">{confirmedEmail}</span>.
          Your password is unchanged.
        </p>
      </AuthLayout>
    )
  }

  // Confirmed by a click rather than on page load: the link works once, and a
  // page that fired on load would spend it when the browser merely previews it.
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { email } = await confirmEmailChange(token)
      setConfirmedEmail(email)
      // Show the new address in this tab too, if it is signed in.
      refreshUser().catch(() => {})
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not confirm the new email. Please try again.'))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Confirm your new email"
      subtitle="After this you sign in to Dictypio with the address this link was sent to."
      error={error}
      footer={onward}
    >
      <form onSubmit={handleSubmit}>
        <AuthSubmit busy={busy}>{busy ? 'Confirming…' : 'Confirm new email'}</AuthSubmit>
      </form>
    </AuthLayout>
  )
}
