// Appearance settings: which theme skin the app wears and which typefaces it
// uses. The colors themselves live in index.css as CSS variables keyed off
// `data-theme` on <html>; this module only decides which key is active and
// persists the choice. Same load*/save* + defaults shape as audio.ts.

export type ThemeId = 'deep-sea' | 'skeuo' | 'system'
export type FontId = 'inter' | 'jetbrains-mono' | 'courier-prime' | 'lora'

// The two real skins. 'system' resolves to one of these at apply time.
export type ResolvedTheme = 'deep-sea' | 'skeuo'

export interface ThemeSettings {
  theme: ThemeId
  uiFont: FontId
  typingFont: FontId
}

export const THEME_DEFAULTS: ThemeSettings = {
  theme: 'deep-sea',
  uiFont: 'inter',
  typingFont: 'jetbrains-mono',
}

export interface ThemeOption {
  id: ThemeId
  label: string
  description: string
  // Swatch colors for the Settings preview card. Hardcoded on purpose: the
  // preview has to show a theme that isn't the active one.
  swatch: { bg: string; panel: string; text: string; accent: string; border: string }
}

const DEEP_SEA_SWATCH = {
  bg: '#060d1a',
  panel: '#0e1c36',
  text: '#f1f5f9',
  accent: '#06b6d4',
  border: 'rgba(6, 182, 212, 0.3)',
}

const SKEUO_SWATCH = {
  bg: '#faf8f4',
  panel: '#ffffff',
  text: '#1c1917',
  accent: '#ea580c',
  border: 'rgba(234, 88, 12, 0.35)',
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'deep-sea',
    label: 'Deep Sea',
    description: 'The original dark abyss with cyan bioluminescence.',
    swatch: DEEP_SEA_SWATCH,
  },
  {
    id: 'skeuo',
    label: 'Skeuomorph',
    description: 'Warm white paper, embossed panels and a glowing orange accent.',
    swatch: SKEUO_SWATCH,
  },
  {
    id: 'system',
    label: 'System',
    description: 'Follows your OS light/dark setting.',
    swatch: SKEUO_SWATCH,
  },
]

export interface FontOption {
  id: FontId
  label: string
  hint: string
  stack: string
  mono: boolean
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'inter',
    label: 'Inter',
    hint: 'Clean UI sans',
    stack: "'Inter Variable', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    mono: false,
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    hint: 'Monospace, wide',
    stack: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    mono: true,
  },
  {
    id: 'courier-prime',
    label: 'Courier Prime',
    hint: 'Typewriter',
    stack: "'Courier Prime', 'Courier New', ui-monospace, Consolas, monospace",
    mono: true,
  },
  {
    id: 'lora',
    label: 'Lora',
    hint: 'Book serif',
    stack: "'Lora Variable', 'Lora', Georgia, 'Times New Roman', serif",
    mono: false,
  },
]

const STORAGE_KEY = 'ear2finger-theme'

const THEME_IDS = THEME_OPTIONS.map((t) => t.id)
const FONT_IDS = FONT_OPTIONS.map((f) => f.id)

export function loadThemeSettings(): ThemeSettings {
  const result = { ...THEME_DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return result
    const parsed = JSON.parse(raw) as Partial<ThemeSettings>
    if (typeof parsed.theme === 'string' && THEME_IDS.includes(parsed.theme as ThemeId)) {
      result.theme = parsed.theme as ThemeId
    }
    if (typeof parsed.uiFont === 'string' && FONT_IDS.includes(parsed.uiFont as FontId)) {
      result.uiFont = parsed.uiFont as FontId
    }
    if (typeof parsed.typingFont === 'string' && FONT_IDS.includes(parsed.typingFont as FontId)) {
      result.typingFont = parsed.typingFont as FontId
    }
  } catch {
    // malformed JSON — fall back to defaults
  }
  return result
}

export function saveThemeSettings(settings: ThemeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable — settings still apply for this session
  }
}

const LIGHT_QUERY = '(prefers-color-scheme: light)'

/** What 'system' means right now. */
export function resolveTheme(theme: ThemeId): ResolvedTheme {
  if (theme !== 'system') return theme
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? 'skeuo' : 'deep-sea'
  } catch {
    return 'deep-sea'
  }
}

export function fontStack(id: FontId): string {
  return (FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0]).stack
}

/** Push the chosen skin and typefaces onto <html>. Safe to call repeatedly. */
export function applyTheme(settings: ThemeSettings): void {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(settings.theme)
  root.style.setProperty('--font-ui', fontStack(settings.uiFont))
  root.style.setProperty('--font-typing', fontStack(settings.typingFont))
}

/**
 * Re-apply on OS light/dark changes while 'system' is selected. Returns an
 * unsubscribe so callers can swap the listener when the setting changes.
 */
export function watchSystemTheme(getSettings: () => ThemeSettings): () => void {
  let media: MediaQueryList
  try {
    media = window.matchMedia(LIGHT_QUERY)
  } catch {
    return () => {}
  }
  const onChange = () => {
    const settings = getSettings()
    if (settings.theme === 'system') applyTheme(settings)
  }
  media.addEventListener('change', onChange)
  // Belt and braces: an OS switch while the window was hidden or unfocused
  // doesn't always deliver the change event, so re-resolve on the way back.
  window.addEventListener('focus', onChange)
  document.addEventListener('visibilitychange', onChange)
  return () => {
    media.removeEventListener('change', onChange)
    window.removeEventListener('focus', onChange)
    document.removeEventListener('visibilitychange', onChange)
  }
}
