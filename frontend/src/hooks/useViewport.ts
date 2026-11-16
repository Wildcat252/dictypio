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

/** True at the md breakpoint and up (the desktop / Electron layout). */
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
 * Keep `--vvh` on <html> equal to the visual viewport height, so `.h-app`
 * frames shrink to the area above the iOS on-screen keyboard instead of the
 * keyboard covering the bottom of the page.
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
        // Only on viewport resize (keyboard open/close), never on scroll:
        // iOS scrolls the whole page to reveal a focused field, which would
        // push the header off-screen now that the frame already fits.
        if (window.scrollY !== 0) window.scrollTo(0, 0)
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
