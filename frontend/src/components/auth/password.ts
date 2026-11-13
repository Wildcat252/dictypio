/** Keep in sync with MIN_PASSWORD_LENGTH in backend/routers/auth.py. */
export const MIN_PASSWORD_LENGTH = 8

/** Why a new password can't be submitted, or null when it is fine. */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password !== confirm) return 'The two passwords do not match.'
  return null
}
