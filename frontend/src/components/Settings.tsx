import { useState, useEffect, useCallback } from 'react'
import { AppHeader } from './AppHeader'
import {
  getConfig,
  setConfig,
  listAIKeys,
  addAIKey,
  activateAIKey,
  deleteAIKey,
  type SetConfigPayload,
  type AIKeyHint,
} from '../api'
import {
  KEYBIND_ACTIONS,
  KEYBIND_DEFAULTS,
  KEYBIND_LABELS,
  loadKeybindings,
  saveKeybindings,
  displayKey,
  type KeybindAction,
} from '../keybindings'
import {
  loadAudioSettings,
  saveAudioSettings,
  type AudioSettings,
} from '../audio'
import { useWorkspace } from '../contexts/WorkspaceContext'
import { usePremiumVoices } from '../voices'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { AccountSection } from './settings/AccountSection'
import { InfoTip, OptionTitle } from './settings/InfoTip'
import { AudioSection } from './settings/AudioSection'
import { ThemeSection } from './settings/ThemeSection'
import {
  applyTheme,
  loadThemeSettings,
  saveThemeSettings,
  type ThemeSettings,
} from '../theme'

type SettingsSection = 'ai-api-key' | 'keybindings' | 'audio' | 'playback' | 'appearance' | 'account'

export default function Settings() {
  const {
    pauseInterval,
    setPauseInterval,
    ignorePunctuation,
    setIgnorePunctuation,
    speakComma,
    setSpeakComma,
    commaPause,
    setCommaPause,
    ignoreCase,
    setIgnoreCase,
    repeatCount,
    setRepeatCount,
    ttsVoiceName,
    setTtsVoiceName,
    ttsMultiVoice,
    setTtsMultiVoice,
    ttsVoiceNames,
    setTtsVoiceNames,
    ttsVoicePerSentenceRepeat,
    setTtsVoicePerSentenceRepeat,
    ttsVoicePerWordRepeat,
    setTtsVoicePerWordRepeat,
    ttsVoiceOrder,
    setTtsVoiceOrder,
  } = useWorkspace()
  const availableVoices = usePremiumVoices()
  // Accounts exist only on the web deployment; the desktop app has no ACCOUNT section.
  const { authEnabled, user } = useAuth()
  const showAccount = authEnabled && user !== null
  // The header's account name links here with the section to open.
  const location = useLocation()
  const wantsAccount = (location.state as { section?: string } | null)?.section === 'account'
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    wantsAccount ? 'account' : 'ai-api-key'
  )
  // The same link pressed while Settings is already open.
  useEffect(() => {
    if (wantsAccount) setActiveSection('account')
  }, [wantsAccount, location.key])
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasGeminiKey, setHasGeminiKey] = useState(false)
  const [aiConfigError, setAiConfigError] = useState<string | null>(null)
  const [aiKeys, setAiKeys] = useState<AIKeyHint[]>([])
  const [aiKeysLoading, setAiKeysLoading] = useState(false)
  const [aiKeysError, setAiKeysError] = useState<string | null>(null)

  const [keybinds, setKeybinds] = useState(loadKeybindings)
  const [capturingAction, setCapturingAction] = useState<KeybindAction | null>(null)
  const [keybindError, setKeybindError] = useState<string | null>(null)
  const [audio, setAudio] = useState<AudioSettings>(loadAudioSettings)
  const [theme, setTheme] = useState<ThemeSettings>(loadThemeSettings)

  const updateTheme = useCallback((patch: Partial<ThemeSettings>) => {
    setTheme((prev) => {
      const next = { ...prev, ...patch }
      saveThemeSettings(next)
      applyTheme(next)
      return next
    })
  }, [])

  const updateAudio = useCallback((patch: Partial<AudioSettings>) => {
    setAudio((prev) => {
      const next = { ...prev, ...patch }
      saveAudioSettings(next)
      return next
    })
  }, [])

  const loadAIKeys = useCallback(() => {
    setAiKeysLoading(true)
    setAiKeysError(null)
    listAIKeys()
      .then((res) => setAiKeys(res.keys))
      .catch(() => {
        setAiKeysError('Failed to load API keys')
      })
      .finally(() => setAiKeysLoading(false))
  }, [])

  useEffect(() => {
    getConfig()
      .then((c) => {
        setHasGeminiKey(Boolean(c.has_gemini_api_key))
      })
      .catch(() => { })
  }, [])

  // Press-to-set capture for keybindings: while a row is armed, the next
  // keydown is taken as the new binding (Escape cancels).
  useEffect(() => {
    if (!capturingAction) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturingAction(null)
        return
      }
      // Bare modifiers: only Command (Meta) is supported as a tap-style binding
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt') {
        setKeybindError('Modifier keys other than ⌘ cannot be bound on their own.')
        return
      }
      // Letters, digits and space are typed into the word inputs during practice
      if (/^[a-zA-Z0-9 ]$/.test(e.key)) {
        setKeybindError('Letters, digits and Space are reserved for typing practice — pick a symbol key.')
        return
      }
      const takenBy = KEYBIND_ACTIONS.find(
        (a) => a !== capturingAction && keybinds[a] === e.key
      )
      if (takenBy) {
        setKeybindError(`"${displayKey(e.key)}" is already used by ${KEYBIND_LABELS[takenBy]}.`)
        return
      }
      const next = { ...keybinds, [capturingAction]: e.key }
      setKeybinds(next)
      saveKeybindings(next)
      setKeybindError(null)
      setCapturingAction(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturingAction, keybinds])

  useEffect(() => {
    if (activeSection === 'ai-api-key') {
      loadAIKeys()
    }
  }, [activeSection, loadAIKeys])

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => {
      if (mq.matches) setMobileNavOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const settingsSections = [
    { id: 'ai-api-key' as SettingsSection, label: 'AI API-KEY' },
    { id: 'keybindings' as SettingsSection, label: 'KEYBOARD SHORTCUTS' },
    { id: 'audio' as SettingsSection, label: 'AUDIO' },
    { id: 'playback' as SettingsSection, label: 'PLAYBACK & GRADING' },
    { id: 'appearance' as SettingsSection, label: 'APPEARANCE' },
    ...(showAccount ? [{ id: 'account' as SettingsSection, label: 'ACCOUNT' }] : []),
  ]

  const handleApply = async () => {
    setAiConfigError(null)
    try {
      const trimmedKey = apiKey.trim()
      if (trimmedKey) {
        await addAIKey(trimmedKey, true)
        await setConfig({ ai_provider: 'gemini' } satisfies SetConfigPayload)
      } else {
        await setConfig({ ai_provider: 'gemini' } satisfies SetConfigPayload)
      }
      setApiKey('')

      const c = await getConfig()
      setHasGeminiKey(Boolean(c.has_gemini_api_key))
      loadAIKeys()
      console.log('Settings saved')
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { detail?: string } } }
      setAiConfigError(ax.response?.data?.detail ?? 'Failed to save AI settings')
      console.error('Failed to save settings', e)
    }
  }

  const handleActivateKey = async (keyId: string) => {
    setAiConfigError(null)
    try {
      await activateAIKey(keyId)
      await setConfig({ ai_provider: 'gemini' } satisfies SetConfigPayload)
      const c = await getConfig()
      setHasGeminiKey(Boolean(c.has_gemini_api_key))
      loadAIKeys()
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { detail?: string } } }
      setAiConfigError(ax.response?.data?.detail ?? 'Failed to activate API key')
    }
  }

  const handleDeleteKey = async (keyId: string) => {
    setAiConfigError(null)
    try {
      await deleteAIKey(keyId)
      const c = await getConfig()
      setHasGeminiKey(Boolean(c.has_gemini_api_key))
      loadAIKeys()
    } catch (e: unknown) {
      const ax = e as { response?: { data?: { detail?: string } } }
      setAiConfigError(ax.response?.data?.detail ?? 'Failed to delete API key')
    }
  }

  return (
    <div className="h-screen min-h-0 flex flex-col bg-abyss-800/80">
      {/* Header */}
      <AppHeader
        active="settings"
      />

      {!mobileNavOpen && (
        <div className="border-b border-cyan-500/20 bg-abyss-800/80 px-4 py-2.5 md:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2.5 text-sm font-medium text-cyan-200 hover:bg-cyan-500/15"
            aria-controls="settings-nav-sidebar"
          >
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h10" />
            </svg>
            Open settings sections
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden min-h-0">
        {/* Left Sidebar */}
        <aside
          id="settings-nav-sidebar"
          className={`w-full md:w-80 shrink-0 max-md:max-h-[min(50vh,380px)] md:max-h-none bg-abyss-900/60 border-cyan-500/20 border-b md:border-b-0 md:border-r flex flex-col min-h-0 ${!mobileNavOpen ? 'max-md:hidden' : ''
            }`}
        >
          <div className="md:hidden flex justify-end border-b border-cyan-500/20 px-3 py-1.5 bg-abyss-900/60">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="text-sm font-medium text-cyan-300 hover:text-cyan-200 py-1 px-2 rounded-md hover:bg-cyan-500/10"
            >
              Done
            </button>
          </div>
          {/* Settings Navigation */}
          <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-1 min-h-0">
            {settingsSections.map((section) => (
              <button
                key={section.id}
                onClick={() => {
                  setActiveSection(section.id)
                  setMobileNavOpen(false)
                }}
                className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${activeSection === section.id
                    ? 'bg-abyss-950 text-ink'
                    : 'bg-abyss-800/80 hover:bg-abyss-750 text-slate-100'
                  }`}
              >
                <span className="font-medium">{section.label}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-abyss-800/80 p-4 md:p-6 flex justify-center min-h-0">
          {activeSection === 'ai-api-key' && (
            <div className="w-full max-w-3xl">
              <h1 className="text-2xl font-bold text-slate-100 mb-2">AI API-KEY</h1>
              <p className="text-sm text-slate-400 mb-6">
                AI uses <strong className="text-slate-100">Google Gemini</strong> for the coach and for embeddings (Qdrant).
                {hasGeminiKey ? ' • API key configured' : ' • No API key saved yet'}
              </p>

              <div className="space-y-6">
                {aiConfigError && (
                  <div className="text-sm text-rose-400 bg-rose-500/10 px-3 py-2 rounded-lg">{aiConfigError}</div>
                )}
                {/* API Key Text Area */}
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    API-KEY
                  </label>
                  <textarea
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      hasGeminiKey
                        ? 'Key is configured. Paste a new key to replace it.'
                        : 'Enter your Gemini API key here...'
                    }
                    rows={8}
                    className="w-full border-2 border-cyan-500/30 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-transparent resize-none"
                  />
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={handleApply}
                      className="px-4 py-2 bg-abyss-950 text-ink font-medium rounded-lg hover:bg-abyss-850 transition-colors"
                    >
                      ADD
                    </button>
                  </div>
                </div>

                {/* Saved keys list (all providers) */}
                <div className="pt-4 border-t border-cyan-500/20">
                  <h2 className="text-sm font-semibold text-slate-100 mb-2">
                    Saved keys
                  </h2>
                  {aiKeysError && (
                    <div className="mb-2 text-sm text-rose-400 bg-rose-500/10 px-3 py-2 rounded-lg">{aiKeysError}</div>
                  )}
                  {aiKeysLoading ? (
                    <p className="text-sm text-slate-400">Loading keys…</p>
                  ) : aiKeys.length === 0 ? (
                    <p className="text-sm text-slate-400">No keys saved yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {aiKeys.map((k) => (
                        <li
                          key={k.id}
                          className="flex items-center justify-between rounded-lg border border-cyan-500/20 px-3 py-2"
                        >
                          <div className="flex flex-col">
                            <span className="text-sm text-slate-100">
                              <span className="mr-2 inline-flex items-center rounded-full bg-abyss-800/60 px-2 py-0.5 text-xs font-medium text-slate-200">
                                Gemini
                              </span>
                              …{k.last4 || '????'}
                              {k.is_active && (
                                <span className="ml-2 inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
                                  Active
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-slate-400">
                              Added {new Date(k.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {!k.is_active && (
                              <button
                                type="button"
                                onClick={() => handleActivateKey(k.id)}
                                className="px-2 py-1 text-xs font-medium text-slate-100 border border-cyan-500/30 rounded hover:bg-abyss-750"
                              >
                                Activate
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteKey(k.id)}
                              className="px-2 py-1 text-xs font-medium text-rose-400 border border-rose-500/30 rounded hover:bg-rose-500/10"
                            >
                              Delete
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

              </div>
            </div>
          )}

          {activeSection === 'keybindings' && (
            <div className="w-full max-w-3xl">
              <h1 className="text-2xl font-bold text-slate-100 mb-2">KEYBOARD SHORTCUTS</h1>
              <p className="text-sm text-slate-400 mb-6">
                Click a shortcut, then press the desired key. Press <kbd className="px-1 py-0.5 bg-abyss-800/60 border border-cyan-500/30 rounded font-mono text-xs">Esc</kbd> to cancel.
                Letters, digits and Space can't be bound — they're used for typing practice.
              </p>

              <div className="space-y-6">
                {keybindError && (
                  <div className="text-sm text-rose-400 bg-rose-500/10 px-3 py-2 rounded-lg">{keybindError}</div>
                )}

                <ul className="space-y-2">
                  {KEYBIND_ACTIONS.map((action) => (
                    <li
                      key={action}
                      className="flex items-center justify-between rounded-lg border border-cyan-500/20 px-3 py-2"
                    >
                      <span className="text-sm text-slate-100">{KEYBIND_LABELS[action]}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setKeybindError(null)
                          setCapturingAction(capturingAction === action ? null : action)
                        }}
                        className={`min-w-[7rem] px-3 py-1.5 text-sm font-mono rounded-lg border transition-colors ${capturingAction === action
                          ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200 animate-glow-pulse'
                          : 'border-cyan-500/30 bg-abyss-800/80 text-slate-100 hover:bg-abyss-750'
                          }`}
                      >
                        {capturingAction === action ? 'Press a key…' : displayKey(keybinds[action])}
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="pt-4 border-t border-cyan-500/20 flex items-center justify-end gap-2">
                  <InfoTip label="When shortcut changes apply">
                    Changes apply the next time you open the Workspace.
                  </InfoTip>
                  <button
                    type="button"
                    onClick={() => {
                      setKeybinds({ ...KEYBIND_DEFAULTS })
                      saveKeybindings({ ...KEYBIND_DEFAULTS })
                      setCapturingAction(null)
                      setKeybindError(null)
                    }}
                    className="px-3 py-1.5 text-sm font-medium text-slate-300 border border-cyan-500/30 rounded-lg hover:bg-abyss-750"
                  >
                    Reset to defaults
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'audio' && (
            <AudioSection
              audio={audio}
              setAudio={setAudio}
              updateAudio={updateAudio}
              ttsVoiceName={ttsVoiceName}
              setTtsVoiceName={setTtsVoiceName}
              availableVoices={availableVoices}
              ttsMultiVoice={ttsMultiVoice}
              setTtsMultiVoice={setTtsMultiVoice}
              ttsVoiceNames={ttsVoiceNames}
              setTtsVoiceNames={setTtsVoiceNames}
              ttsVoicePerSentenceRepeat={ttsVoicePerSentenceRepeat}
              setTtsVoicePerSentenceRepeat={setTtsVoicePerSentenceRepeat}
              ttsVoicePerWordRepeat={ttsVoicePerWordRepeat}
              setTtsVoicePerWordRepeat={setTtsVoicePerWordRepeat}
              ttsVoiceOrder={ttsVoiceOrder}
              setTtsVoiceOrder={setTtsVoiceOrder}
            />
          )}

          {activeSection === 'playback' && (
            <div className="w-full max-w-3xl text-left">
              <h1 className="text-2xl font-bold text-slate-100 mb-2">PLAYBACK &amp; GRADING</h1>
              <p className="text-sm text-slate-400 mb-6">
                How sentences repeat and pause during practice, and how strictly your typing is graded.
              </p>

              <div className="space-y-4">
                {/* Repeat count */}
                <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 p-4">
                  <div>
                    <OptionTitle
                      title="Repeat count"
                      hint="How many times each sentence plays before advancing (∞ = until you move on)."
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    {([0, 1, 3, 5, 10, '∞'] as const).map((count) => (
                      <button
                        key={String(count)}
                        type="button"
                        onClick={() => setRepeatCount(count === '∞' ? '∞' : count)}
                        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${repeatCount === count
                          ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-300 font-semibold'
                          : 'border-cyan-500/30 bg-abyss-800/80 text-slate-100 hover:bg-abyss-750'
                          }`}
                      >
                        {count === '∞' ? '∞' : count}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pause interval */}
                <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 p-4">
                  <div>
                    <OptionTitle
                      title="Pause between plays"
                      hint="Silent gap after a sentence finishes, in seconds."
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={0.5}
                      value={pauseInterval}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (Number.isFinite(v)) setPauseInterval(Math.min(60, Math.max(0, v)))
                      }}
                      className="w-20 border border-cyan-500/30 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                    />
                    <span className="text-sm text-slate-400">sec</span>
                  </div>
                </div>

                {/* Speak comma */}
                <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 p-4">
                  <div>
                    <OptionTitle
                      title="Speak “comma”"
                      hint="In word-by-word mode, read commas aloud as “comma”."
                    />
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={speakComma}
                      onChange={(e) => setSpeakComma(e.target.checked)}
                    />
                    <div className="relative w-11 h-6 bg-abyss-750 rounded-full peer peer-checked:bg-cyan-600 shadow-glow-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-abyss-800/80 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5"></div>
                  </label>
                </div>

                {/* Comma pause (replaces the spoken "comma") */}
                {!speakComma && (
                  <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 p-4 ml-6">
                    <div>
                      <OptionTitle
                        title="Comma pause"
                        hint="Silent gap at each comma instead of saying “comma”, in seconds."
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCommaPause(Math.max(0, Math.round((commaPause - 0.1) * 10) / 10))}
                        disabled={commaPause <= 0}
                        className="w-8 h-8 rounded-lg border border-cyan-500/30 text-slate-100 hover:bg-cyan-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Decrease comma pause"
                      >
                        &minus;
                      </button>
                      <input
                        type="number"
                        min={0}
                        max={5}
                        step={0.1}
                        value={commaPause}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (Number.isFinite(v)) setCommaPause(Math.min(5, Math.max(0, v)))
                        }}
                        className="w-20 border border-cyan-500/30 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                      />
                      <button
                        type="button"
                        onClick={() => setCommaPause(Math.min(5, Math.round((commaPause + 0.1) * 10) / 10))}
                        disabled={commaPause >= 5}
                        className="w-8 h-8 rounded-lg border border-cyan-500/30 text-slate-100 hover:bg-cyan-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label="Increase comma pause"
                      >
                        +
                      </button>
                      <span className="text-sm text-slate-400">sec</span>
                    </div>
                  </div>
                )}

                {/* Ignore punctuation */}
                <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 p-4">
                  <div>
                    <OptionTitle
                      title="Ignore punctuation"
                      hint="When on, punctuation isn't required to match (commas, periods, etc.)."
                    />
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={ignorePunctuation}
                      onChange={(e) => setIgnorePunctuation(e.target.checked)}
                    />
                    <div className="relative w-11 h-6 bg-abyss-750 rounded-full peer peer-checked:bg-cyan-600 shadow-glow-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-abyss-800/80 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5"></div>
                  </label>
                </div>

                {/* Ignore case */}
                <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 p-4">
                  <div>
                    <OptionTitle
                      title="Ignore case"
                      hint="When on, uppercase and lowercase are treated the same."
                    />
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={ignoreCase}
                      onChange={(e) => setIgnoreCase(e.target.checked)}
                    />
                    <div className="relative w-11 h-6 bg-abyss-750 rounded-full peer peer-checked:bg-cyan-600 shadow-glow-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-abyss-800/80 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5"></div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <ThemeSection theme={theme} updateTheme={updateTheme} />
          )}

          {activeSection === 'account' && showAccount && <AccountSection />}
        </main>
      </div>
    </div>
  )
}
