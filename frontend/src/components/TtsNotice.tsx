import { useEffect, useState } from 'react'
import { TTS_NOTICE_EVENT, type TtsNotice as Notice } from '../tts'
import { TIER_LABELS } from '../voices'

const SHOW_MS = 8000

function message(n: Notice): string {
  if (n.kind === 'quota') {
    const family = n.tier ? TIER_LABELS[n.tier] : 'Google'
    const instead =
      n.fallback && n.fallback !== 'browser' ? `a ${TIER_LABELS[n.fallback]} voice` : 'a browser voice'
    return n.period === 'day'
      ? `You have used today's ${family} allowance, so new sentences are read with ${instead} until tomorrow.`
      : `This month's free ${family} quota is used up, so new sentences are read with ${instead} until next month.`
  }
  return 'Google voices are unavailable right now, so a browser voice is reading instead.'
}

/** Brief notice when playback had to fall back from a Google voice to a browser one. */
export function TtsNotice() {
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onNotice = (e: Event) => {
      setNotice((e as CustomEvent<Notice>).detail)
      clearTimeout(timer)
      timer = setTimeout(() => setNotice(null), SHOW_MS)
    }
    window.addEventListener(TTS_NOTICE_EVENT, onNotice)
    return () => {
      window.removeEventListener(TTS_NOTICE_EVENT, onNotice)
      clearTimeout(timer)
    }
  }, [])

  if (!notice) return null
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-lg border border-amber-400/40 bg-abyss-800/95 px-4 py-3 text-sm text-amber-100 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <p className="flex-1">{message(notice)}</p>
        <button
          type="button"
          onClick={() => setNotice(null)}
          className="text-amber-200/70 hover:text-amber-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}
