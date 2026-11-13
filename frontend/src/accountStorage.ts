/**
 * What an account leaves behind in this browser: the caches to drop when it
 * signs out, and a one-time message for the sign-in page it lands on.
 */

// Owned by WorkspaceContext, Practice and Dashboard respectively. They hold one
// account's lessons and results, so they live here where sign-out can clear them.
export const WORKSPACE_PROGRESS_KEY = 'ear2finger-workspace-progress'
export const PRACTICE_STATE_KEY = 'ear2finger-practice-state'
export const COACH_FEEDBACK_KEY = 'ear2finger_ai_coach_feedback_v1'

const SIGNED_OUT_NOTICE_KEY = 'dictypio-signed-out-notice'

/** Forget what the signed-in account cached here. Preferences (theme, audio, shortcuts) stay. */
export function clearAccountCaches() {
  try {
    for (const key of [WORKSPACE_PROGRESS_KEY, PRACTICE_STATE_KEY, COACH_FEEDBACK_KEY]) {
      localStorage.removeItem(key)
    }
  } catch {
    // Storage unavailable: nothing was cached in the first place.
  }
}

/** Sign-out reloads the page, so a message for the sign-in page has to wait in storage. */
export function setSignedOutNotice(text: string) {
  try {
    sessionStorage.setItem(SIGNED_OUT_NOTICE_KEY, text)
  } catch {
    // The user just doesn't see the message.
  }
}

export function readSignedOutNotice(): string | null {
  try {
    return sessionStorage.getItem(SIGNED_OUT_NOTICE_KEY)
  } catch {
    return null
  }
}

export function clearSignedOutNotice() {
  try {
    sessionStorage.removeItem(SIGNED_OUT_NOTICE_KEY)
  } catch {
    // Nothing to clear.
  }
}
