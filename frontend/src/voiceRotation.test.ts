import { describe, expect, it } from 'vitest'
import {
  MAX_VOICE_POOL,
  MIN_VOICE_POOL,
  orderPoolForSentence,
  pickRandomVoices,
  resolveVoicePool,
  voiceForRepeat,
} from './voiceRotation'

const voices = ['Ava', 'Ben', 'Cleo', 'Dan', 'Eve'].map((name) => ({ name }))

describe('resolveVoicePool', () => {
  it('keeps the saved order and drops voices that are gone', () => {
    const pool = resolveVoicePool(['Cleo', 'Gone', 'Ava'], voices)
    expect(pool.map((v) => v.name)).toEqual(['Cleo', 'Ava'])
  })

  it('ignores a duplicated name', () => {
    expect(resolveVoicePool(['Ava', 'Ava'], voices)).toHaveLength(1)
  })

  it('is empty without names or without voices', () => {
    expect(resolveVoicePool([], voices)).toEqual([])
    expect(resolveVoicePool(['Ava'], [])).toEqual([])
  })
})

describe('orderPoolForSentence', () => {
  it('keeps a fixed pool as it is, in a new array', () => {
    const pool = ['a', 'b', 'c']
    const ordered = orderPoolForSentence(pool, 'fixed', 'any')
    expect(ordered).toEqual(pool)
    expect(ordered).not.toBe(pool)
  })

  it('shuffles the same way every time for one sentence', () => {
    const pool = ['a', 'b', 'c', 'd']
    const first = orderPoolForSentence(pool, 'random', 'sentence-7')
    expect(orderPoolForSentence(pool, 'random', 'sentence-7')).toEqual(first)
    expect([...first].sort()).toEqual(pool)
  })

  it('does not give every sentence the same order', () => {
    const pool = ['a', 'b', 'c', 'd']
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) => orderPoolForSentence(pool, 'random', `s${i}`).join(''))
    )
    expect(orders.size).toBeGreaterThan(1)
  })
})

describe('pickRandomVoices', () => {
  it('clamps the count to the allowed pool size', () => {
    expect(pickRandomVoices(voices, 0)).toHaveLength(MIN_VOICE_POOL)
    expect(pickRandomVoices(voices, 99)).toHaveLength(MAX_VOICE_POOL)
  })

  it('never returns more voices than exist, nor a voice twice', () => {
    expect(pickRandomVoices(voices.slice(0, 1), 3)).toEqual(['Ava'])
    const picked = pickRandomVoices(voices, 4)
    expect(new Set(picked).size).toBe(picked.length)
  })
})

describe('voiceForRepeat', () => {
  it('wraps around the pool', () => {
    const pool = ['a', 'b', 'c']
    expect([0, 1, 2, 3, 4].map((i) => voiceForRepeat(pool, i))).toEqual(['a', 'b', 'c', 'a', 'b'])
  })

  it('falls back to the first voice for a bad index', () => {
    expect(voiceForRepeat(['a', 'b'], -1)).toBe('a')
    expect(voiceForRepeat(['a', 'b'], NaN)).toBe('a')
  })

  it('is null for an empty pool', () => {
    expect(voiceForRepeat([], 0)).toBeNull()
  })
})
