import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react'
import * as api from '../api'
import type { AuthUser } from '../api'
import { clearAccountCaches, setSignedOutNotice } from '../accountStorage'

interface AuthContextValue {
  /** False on the desktop app, where there are no accounts and nothing is gated. */
  authEnabled: boolean
  user: AuthUser | null
  /** True until we know whether accounts are enabled and whether the stored session is valid. */
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  /** Ends the session and reloads onto the sign-in page, optionally with a message to show there. */
  logout: (notice?: string) => void
  /** Swap in a new token, as issued after a password change. */
  setSession: (token: string, user: AuthUser) => void
  /** Reflect a profile change the server has already saved. */
  updateUser: (user: AuthUser) => void
  /** Re-read the account, e.g. after its email was confirmed in another tab. */
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authEnabled, setAuthEnabled] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { auth_enabled } = await api.fetchAuthConfig()
        if (cancelled) return
        setAuthEnabled(auth_enabled)
        if (auth_enabled && api.getAuthToken()) {
          const me = await api.fetchMe()
          if (!cancelled) setUser(me)
        }
      } catch {
        // Config unreachable or session rejected: stay signed out. If the server
        // does require sign-in, its first 401 raises AUTH_LOGOUT_EVENT below.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onRejected = () => {
      setAuthEnabled(true)
      setUser(null)
    }
    window.addEventListener(api.AUTH_LOGOUT_EVENT, onRejected)
    return () => window.removeEventListener(api.AUTH_LOGOUT_EVENT, onRejected)
  }, [])

  const setSession = useCallback((token: string, nextUser: AuthUser) => {
    api.setAuthToken(token)
    setUser(nextUser)
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email, password)
      setSession(res.access_token, res.user)
    },
    [setSession]
  )

  const register = useCallback(
    async (email: string, password: string) => {
      const res = await api.register(email, password)
      setSession(res.access_token, res.user)
    },
    [setSession]
  )

  const logout = useCallback((notice?: string) => {
    api.setAuthToken(null)
    // The next person to sign in on this browser must not find this account's lessons.
    clearAccountCaches()
    if (notice) setSignedOutNotice(notice)
    // A full reload drops everything the previous account loaded into memory.
    window.location.assign('/login')
  }, [])

  const refreshUser = useCallback(async () => {
    if (!api.getAuthToken()) return
    // A rejected session surfaces through AUTH_LOGOUT_EVENT, like any other call.
    setUser(await api.fetchMe())
  }, [])

  const value = useMemo(
    () => ({
      authEnabled,
      user,
      loading,
      login,
      register,
      logout,
      setSession,
      updateUser: setUser,
      refreshUser,
    }),
    [authEnabled, user, loading, login, register, logout, setSession, refreshUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
