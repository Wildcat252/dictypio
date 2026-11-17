import { describe, expect, it } from 'vitest'
import { MIN_PASSWORD_LENGTH, passwordProblem } from './password'

describe('passwordProblem', () => {
  const good = 'x'.repeat(MIN_PASSWORD_LENGTH)

  it('accepts a long enough password typed twice', () => {
    expect(passwordProblem(good, good)).toBeNull()
  })

  it('rejects a password that is too short', () => {
    const short = good.slice(1)
    expect(passwordProblem(short, short)).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it('rejects a confirmation that differs', () => {
    expect(passwordProblem(good, good + 'y')).toMatch(/do not match/)
  })

  it('reports the length before the mismatch', () => {
    expect(passwordProblem('a', 'b')).toContain('at least')
  })
})
