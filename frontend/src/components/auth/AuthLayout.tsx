import { InputHTMLAttributes, ReactNode, useId } from 'react'
import { Link } from 'react-router-dom'

interface AuthLayoutProps {
  title: string
  subtitle?: string
  error?: string | null
  notice?: string | null
  children: ReactNode
  /** Links under the card, e.g. to the other auth pages */
  footer?: ReactNode
}

/** Centered card shared by the sign-in, sign-up and password reset pages. */
export function AuthLayout({ title, subtitle, error, notice, children, footer }: AuthLayoutProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-abyss-900 px-4 py-8 text-slate-100">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <img src="/logo.svg" alt="" className="w-10 h-10 rounded-lg" aria-hidden />
          <span className="text-2xl font-bold bg-gradient-to-r from-cyan-300 via-teal-200 to-sky-300 bg-clip-text text-transparent tracking-wide">
            Dictypio
          </span>
        </div>
        <div className="bg-abyss-800/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
          <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
          {error && (
            <div role="alert" className="mt-4 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="mt-4 text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
              {notice}
            </div>
          )}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-slate-400">{footer}</div>}
      </div>
    </div>
  )
}

interface AuthFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  /** Shown to the right of the label, e.g. a "Forgot password?" link */
  labelAside?: ReactNode
}

export function AuthField({ label, labelAside, ...inputProps }: AuthFieldProps) {
  const id = useId()
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label htmlFor={id} className="block text-sm font-medium text-slate-300">
          {label}
        </label>
        {labelAside}
      </div>
      <input
        id={id}
        required
        {...inputProps}
        className="w-full px-3 py-2 rounded-lg bg-abyss-900 border border-cyan-500/20 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
      />
    </div>
  )
}

export function AuthSubmit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full py-2.5 rounded-lg font-semibold text-white bg-gradient-to-r from-cyan-500 via-teal-500 to-sky-600 shadow-glow-cyan hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed transition"
    >
      {children}
    </button>
  )
}

export function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-cyan-300 hover:text-cyan-200 hover:underline">
      {children}
    </Link>
  )
}
