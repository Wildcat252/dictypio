import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Fresh module per test: waitForServer keeps its "ready" flag at module level.
async function load() {
  vi.resetModules()
  return await import('./api')
}

describe('waitForServer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps asking until the health check answers, then stays ready', async () => {
    const mod = await load()
    const get = vi
      .spyOn(mod.api, 'get')
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ data: '<html>starting…</html>' }) // placeholder page
      .mockResolvedValue({ data: { status: 'healthy' } })

    const done = mod.waitForServer()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await done).toBe(true)
    expect(get).toHaveBeenCalledTimes(3)
    expect(mod.isServerReady()).toBe(true)

    // Once up, later callers do not ask again.
    expect(await mod.waitForServer()).toBe(true)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('gives up after a long wait instead of hanging forever', async () => {
    const mod = await load()
    vi.spyOn(mod.api, 'get').mockRejectedValue(new Error('down'))
    const done = mod.waitForServer()
    await vi.advanceTimersByTimeAsync(130_000)
    expect(await done).toBe(false)
    expect(mod.isServerReady()).toBe(false)
  })
})
