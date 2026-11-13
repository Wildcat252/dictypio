import {
  FONT_OPTIONS,
  THEME_OPTIONS,
  fontStack,
  resolveTheme,
  type FontId,
  type ThemeOption,
  type ThemeSettings,
} from '../../theme'
import { InfoTip, OptionTitle } from './InfoTip'

interface ThemeSectionProps {
  theme: ThemeSettings
  updateTheme: (patch: Partial<ThemeSettings>) => void
}

/** Settings → APPEARANCE: the theme skin plus the UI and typing typefaces. */
export function ThemeSection({ theme, updateTheme }: ThemeSectionProps) {
  const activeSkin = resolveTheme(theme.theme)

  return (
    <div className="w-full max-w-3xl text-left">
      <h1 className="text-2xl font-bold text-slate-100 mb-2">APPEARANCE</h1>
      <p className="text-sm text-slate-400 mb-6">
        How Dictypio looks while you practice — the skin it wears and the type it sets.
      </p>

      <div className="space-y-6">
        {/* Theme picker */}
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100 mb-3">
            Theme
            {theme.theme === 'system' && (
              <InfoTip label="About the System theme">
                Your system is currently{' '}
                <span className="text-cyan-300 font-medium">
                  {activeSkin === 'skeuo' ? 'light — showing Skeuomorph' : 'dark — showing Deep Sea'}
                </span>
                .
              </InfoTip>
            )}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {THEME_OPTIONS.map((option) => (
              <ThemeCard
                key={option.id}
                option={option}
                selected={theme.theme === option.id}
                onSelect={() => updateTheme({ theme: option.id })}
              />
            ))}
          </div>
        </div>

        {/* Interface font */}
        <div className="rounded-lg border border-cyan-500/20 p-4 shadow-glass-card">
          <OptionTitle
            title="Interface font"
            hint="Menus, labels and buttons across the app."
            className="mb-3"
          />
          <FontPicker
            value={theme.uiFont}
            onSelect={(uiFont) => updateTheme({ uiFont })}
          />
        </div>

        {/* Typing font */}
        <div className="rounded-lg border border-cyan-500/20 p-4 shadow-glass-card">
          <OptionTitle
            title="Typing font"
            hint="The dictation box and sentence text. A monospaced face keeps every character the same width, so your typing stays lined up with what you hear."
            className="mb-3"
          />
          <FontPicker
            value={theme.typingFont}
            onSelect={(typingFont) => updateTheme({ typingFont })}
          />
          <div
            className="mt-3 rounded-lg border border-cyan-500/20 bg-abyss-950/60 px-3 py-2 text-sm text-cyan-200/90"
            style={{ fontFamily: fontStack(theme.typingFont) }}
          >
            The quick brown fox jumps over 12 lazy dogs.
          </div>
        </div>
      </div>
    </div>
  )
}

function ThemeCard({
  option,
  selected,
  onSelect,
}: {
  option: ThemeOption
  selected: boolean
  onSelect: () => void
}) {
  const { swatch } = option

  return (
    // The card is itself a button, so its InfoTip sits beside it in the
    // wrapper rather than nested inside.
    <div className="relative">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full h-full text-left rounded-xl border p-3 transition-colors ${selected
          ? 'border-cyan-400/60 bg-cyan-500/10 shadow-glow-cyan'
          : 'border-cyan-500/30 bg-abyss-800/80 hover:bg-abyss-750'
          }`}
      >
        {/* Miniature of the theme, painted from its own swatch so it looks
            right no matter which theme is currently active. */}
        <div
          className="mb-3 h-16 w-full rounded-lg border overflow-hidden flex"
          style={{ background: swatch.bg, borderColor: swatch.border }}
        >
          <div className="w-1/3 h-full" style={{ background: swatch.panel }}>
            <div className="m-1.5 h-1.5 rounded-full" style={{ background: swatch.accent }} />
            <div className="m-1.5 h-1.5 rounded-full opacity-40" style={{ background: swatch.text }} />
            <div className="m-1.5 h-1.5 rounded-full opacity-40" style={{ background: swatch.text }} />
          </div>
          <div className="flex-1 p-1.5 flex flex-col justify-center gap-1">
            <div className="h-1.5 w-4/5 rounded-full opacity-70" style={{ background: swatch.text }} />
            <div className="h-1.5 w-3/5 rounded-full opacity-40" style={{ background: swatch.text }} />
            <div
              className="h-2.5 w-1/3 rounded"
              style={{ background: swatch.accent, boxShadow: `0 0 8px ${swatch.accent}` }}
            />
          </div>
        </div>
        <p className={`pr-6 text-sm font-semibold ${selected ? 'text-cyan-300' : 'text-slate-100'}`}>
          {option.label}
        </p>
      </button>
      <InfoTip label={`About the ${option.label} theme`} className="absolute right-3 bottom-3.5">
        {option.description}
      </InfoTip>
    </div>
  )
}

function FontPicker({
  value,
  onSelect,
}: {
  value: FontId
  onSelect: (id: FontId) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {FONT_OPTIONS.map((font) => (
        <button
          key={font.id}
          type="button"
          onClick={() => onSelect(font.id)}
          style={{ fontFamily: font.stack }}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${value === font.id
            ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-300 font-semibold'
            : 'border-cyan-500/30 bg-abyss-800/80 text-slate-100 hover:bg-abyss-750'
            }`}
          title={font.hint}
        >
          {font.label}
        </button>
      ))}
    </div>
  )
}
