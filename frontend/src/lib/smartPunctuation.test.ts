import { describe, expect, it } from 'vitest'
import { straightenPunctuation } from './smartPunctuation'

describe('straightenPunctuation', () => {
  it('turns curly quotes into straight ones', () => {
    expect(straightenPunctuation('don’t')).toBe("don't")
    expect(straightenPunctuation('“hello”')).toBe('"hello"')
  })

  it('turns dashes and the ellipsis back into what was typed', () => {
    expect(straightenPunctuation('well–known')).toBe('well-known')
    expect(straightenPunctuation('wait—what')).toBe('wait-what')
    expect(straightenPunctuation('so…')).toBe('so...')
  })

  it('leaves plain text alone', () => {
    expect(straightenPunctuation(`it's "fine" - really...`)).toBe(`it's "fine" - really...`)
  })
})
