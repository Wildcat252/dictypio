import { FormEvent, InputHTMLAttributes, ReactNode, useEffect, useId, useState } from 'react'
import {
  apiErrorMessage,
  changePassword,
  deleteAccount,
  requestEmailChange,
  updateDisplayName,
  type AuthUser,
} from '../../api'
import { useAuth } from '../../contexts/AuthContext'
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../auth/password'
import { InfoTip } from './InfoTip'

/** Keep in sync with MAX_DISPLAY_NAME_LENGTH in backend/routers/account.py. */
const MAX_DISPLAY_NAME_LENGTH = 50

/** Settings → ACCOUNT: display name, email, password, and deleting the account. */
export function AccountSection() {
  const { user, refreshUser } = useAuth()

  // An email change is confirmed from a link, usually in another tab; pick it
  // up when the user comes back to this one.
  useEffect(() => {
    const onFocus = () => {
      refreshUser().catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshUser])

  if (!user) return null

  return (
    <div className="w-full max-w-3xl text-left">
      <h1 className="text-2xl font-bold text-slate-100 mb-2">ACCOUNT</h1>
      <p className="text-sm text-slate-400 mb-6">
        Your name, how you sign in, and the data kept for this account.
      </p>

      <div className="space-y-4">
        <DisplayNameCard user={user} />
        <EmailCard user={user} />
        <PasswordCard />
        <DeleteAccountCard />
      </div>
    </div>
  )
}

function DisplayNameCard({ user }: { user: AuthUser }) {
  const { updateUser } = useAuth()
  const saved = user.display_name ?? ''
  const [name, setName] = useState(saved)
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus(null)
    setBusy(true)
    try {
      const next = await updateDisplayName(name)
      updateUser(next)
      // The server trims the name; show what it kept.
      setName(next.display_name ?? '')
      setStatus({ ok: next.display_name ? 'Name saved.' : 'Name removed.' })
    } catch (err) {
      setStatus({ error: apiErrorMessage(err, 'Could not save the name. Please try again.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Display name"
      description="Shown in the top bar instead of your email. Leave it empty to show the email."
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <StatusMessage status={status} />
        <Field
          label="Name"
          type="text"
          autoComplete="nickname"
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Actions>
          <SubmitButton busy={busy} disabled={name.trim() === saved}>
            Save name
          </SubmitButton>
        </Actions>
      </form>
    </Card>
  )
}

function EmailCard({ user }: { user: AuthUser }) {
  const [newEmail, setNewEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus(null)
    setBusy(true)
    try {
      const { email } = await requestEmailChange(newEmail.trim(), password)
      setNewEmail('')
      setPassword('')
      setStatus({
        ok: `We sent a confirmation link to ${email}. Open it within 30 minutes to switch; until then you keep signing in with ${user.email}.`,
      })
    } catch (err) {
      setStatus({ error: apiErrorMessage(err, 'Could not start the email change. Please try again.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Email"
      description="You sign in with this address, and password reset links go there. A new address takes effect once you confirm it from a link we send to it."
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <StatusMessage status={status} />
        <div>
          <p className="text-sm font-medium text-slate-300 mb-1">Current email</p>
          <p className="text-sm text-slate-100 break-all">{user.email}</p>
        </div>
        <Field
          label="New email"
          type="email"
          autoComplete="email"
          required
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Actions>
          <SubmitButton busy={busy}>Send confirmation link</SubmitButton>
        </Actions>
      </form>
    </Card>
  )
}

function PasswordCard() {
  const { setSession } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(next, confirm)
    if (problem) {
      setStatus({ error: problem })
      return
    }
    setStatus(null)
    setBusy(true)
    try {
      const res = await changePassword(current, next)
      // The old token stopped working with the old password.
      setSession(res.access_token, res.user)
      setCurrent('')
      setNext('')
      setConfirm('')
      setStatus({ ok: 'Password changed. Other devices have been signed out.' })
    } catch (err) {
      setStatus({ error: apiErrorMessage(err, 'Could not change the password. Please try again.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Password" description="Changing it signs you out everywhere except here.">
      <form onSubmit={handleSubmit} className="space-y-3">
        <StatusMessage status={status} />
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Actions>
          <SubmitButton busy={busy}>Change password</SubmitButton>
        </Actions>
      </form>
    </Card>
  )
}

function DeleteAccountCard() {
  const { logout } = useAuth()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setOpen(false)
    setPassword('')
    setStatus(null)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus(null)
    setBusy(true)
    try {
      await deleteAccount(password)
      // Leaves the page, so there is no state to tidy up here.
      logout('Your account and all of its data were deleted.')
    } catch (err) {
      setStatus({ error: apiErrorMessage(err, 'Could not delete the account. Please try again.') })
      setBusy(false)
    }
  }

  return (
    <Card
      danger
      title="Delete account"
      description="Permanently deletes this account together with its lessons and playlists, downloaded audio, practice history and saved API keys. This cannot be undone."
    >
      {!open ? (
        <Actions>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="px-4 py-2 text-sm font-medium text-rose-400 border border-rose-500/40 rounded-lg hover:bg-rose-500/10 transition-colors"
          >
            Delete account…
          </button>
        </Actions>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <StatusMessage status={status} />
          {/* Stays visible even though the card's description moved into a
              tooltip: nobody should confirm this without seeing what it does. */}
          <p className="text-sm text-rose-400">
            This deletes all your lessons, audio, practice history and API keys. It cannot be undone.
          </p>
          <Field
            label="Enter your password to confirm"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Actions>
            <button
              type="button"
              onClick={close}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-slate-300 border border-cyan-500/30 rounded-lg hover:bg-abyss-750 disabled:opacity-60 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Deleting…' : 'Delete my account permanently'}
            </button>
          </Actions>
        </form>
      )}
    </Card>
  )
}

type Status = { ok: string } | { error: string } | null

function StatusMessage({ status }: { status: Status }) {
  if (!status) return null
  if ('error' in status) {
    return (
      <div role="alert" className="text-sm text-rose-400 bg-rose-500/10 px-3 py-2 rounded-lg">
        {status.error}
      </div>
    )
  }
  return (
    <div role="status" className="text-sm text-emerald-300 bg-emerald-500/10 px-3 py-2 rounded-lg">
      {status.ok}
    </div>
  )
}

function Card({
  title,
  description,
  danger = false,
  children,
}: {
  title: string
  description: ReactNode
  danger?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={`rounded-lg border p-4 shadow-glass-card ${danger ? 'border-rose-500/40' : 'border-cyan-500/20'}`}
    >
      <h2
        className={`flex items-center gap-1.5 mb-3 text-sm font-semibold ${danger ? 'text-rose-400' : 'text-slate-100'}`}
      >
        {title}
        <InfoTip label={`About ${title}`}>{description}</InfoTip>
      </h2>
      {children}
    </section>
  )
}

function Field({ label, ...inputProps }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-300 mb-1">
        {label}
      </label>
      <input
        id={id}
        {...inputProps}
        className="w-full max-w-md border border-cyan-500/30 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
      />
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>
}

function SubmitButton({
  busy,
  disabled = false,
  children,
}: {
  busy: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="px-4 py-2 text-sm bg-abyss-950 text-ink font-medium rounded-lg hover:bg-abyss-850 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {busy ? 'Working…' : children}
    </button>
  )
}
