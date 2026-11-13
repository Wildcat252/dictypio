import { ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const GAP = 6
const VIEWPORT_MARGIN = 8

interface InfoTipProps {
  /** Accessible name of the icon, e.g. "About Repeat count". */
  label: string
  /** What the option does. */
  children?: ReactNode
  /** Something wrong with the current setting; also turns the icon amber. */
  warning?: ReactNode
  className?: string
}

/**
 * A small "i" next to a setting that shows its explanation on hover, keyboard
 * focus or tap. Renders nothing when there is nothing to say.
 */
export function InfoTip({ label, children, warning, className = '' }: InfoTipProps) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Opened by a click or tap rather than by hovering: stays open after the
  // pointer leaves, until it is clicked again or dismissed.
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setPinned(false)
  }, [])

  // Placed after layout, from the icon's spot on screen: below it, or above
  // when there is no room, and always inside the viewport.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const button = buttonRef.current
    const tip = tipRef.current
    if (!button || !tip) return
    const anchor = button.getBoundingClientRect()
    const box = tip.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = window.innerHeight

    let top = anchor.bottom + GAP
    const fitsBelow = top + box.height <= viewportHeight - VIEWPORT_MARGIN
    const fitsAbove = anchor.top - GAP - box.height >= VIEWPORT_MARGIN
    if (!fitsBelow && fitsAbove) top = anchor.top - GAP - box.height

    const centered = anchor.left + anchor.width / 2 - box.width / 2
    const left = Math.min(
      Math.max(centered, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - box.width)
    )
    setPosition({ top, left })
  }, [open, children, warning])

  // The tooltip is pinned to where the icon was, so anything that moves the
  // icon closes it; so do Escape and a tap anywhere else.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target) || tipRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  if (!children && !warning) return null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          if (!pinned) setOpen(false)
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={(e) => {
          // Inside a <label>, a click would otherwise also toggle its checkbox.
          e.preventDefault()
          e.stopPropagation()
          if (pinned) {
            close()
          } else {
            setPinned(true)
            setOpen(true)
          }
        }}
        className={`inline-flex shrink-0 items-center justify-center w-4 h-4 align-middle rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 ${
          warning ? 'text-amber-300 hover:text-amber-200' : 'text-slate-500 hover:text-cyan-300'
        } ${className}`}
      >
        <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" />
          {warning ? (
            <>
              <path d="M8 4.5v4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="8" cy="11.25" r="0.95" fill="currentColor" />
            </>
          ) : (
            <>
              <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
              <path d="M8 7.25v4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </>
          )}
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{
              position: 'fixed',
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              // Measured first, shown once placed, so it never flashes at the corner.
              visibility: position ? 'visible' : 'hidden',
            }}
            className="z-50 w-max max-w-[min(20rem,calc(100vw-16px))] rounded-lg border border-cyan-500/30 bg-abyss-900 px-3 py-2 text-left text-xs font-normal leading-relaxed text-slate-200 shadow-glass-card space-y-1.5"
          >
            {children && <div>{children}</div>}
            {warning && <div className="text-amber-300 space-y-1.5">{warning}</div>}
          </div>,
          document.body
        )}
    </>
  )
}

interface OptionTitleProps {
  title: string
  /** What the option does, shown in the tooltip. */
  hint?: ReactNode
  warning?: ReactNode
  className?: string
}

/** A setting's name with its explanation tucked into an InfoTip. */
export function OptionTitle({ title, hint, warning, className = '' }: OptionTitleProps) {
  return (
    <p className={`flex items-center gap-1.5 text-sm font-semibold text-slate-100 ${className}`}>
      <span>{title}</span>
      <InfoTip label={`About ${title}`} warning={warning}>
        {hint}
      </InfoTip>
    </p>
  )
}
