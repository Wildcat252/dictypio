import { useEffect, useState } from 'react'

const DESKTOP_QUERY = '(min-width: 768px)'
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)'

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** True at the md breakpoint and up (the desktop layout). */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY)
}

/** True on touch-only devices (phones, iPad without a trackpad). */
export function useIsTouchOnly(): boolean {
  return useMediaQuery(TOUCH_QUERY)
}

/** Non-hook check for event handlers. */
export function isTouchOnly(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches
}

/**
 * Keep `--vvh` on <html> equal to the visual viewport height, for
 * overlays (modals, drawers) that must fit above the iOS keyboard. The main
 * `.h-app` frame deliberately ignores it so typing never reflows the page.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      })
    }
    update()
    vv.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      vv.removeEventListener('resize', update)
      root.style.removeProperty('--vvh')
    }
  }, [])
}
