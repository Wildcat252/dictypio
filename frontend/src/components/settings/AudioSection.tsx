import {
  AUDIO_DEFAULTS,
  WAVEFORMS,
  ERROR_FREQ_MIN,
  ERROR_FREQ_MAX,
  ERROR_DURATION_MIN,
  ERROR_DURATION_MAX,
  NOTE_COUNT_MIN,
  NOTE_COUNT_MAX,
  NOTE_SPACING_MIN,
  NOTE_SPACING_MAX,
  saveAudioSettings,
  playCelebrationChime,
  playMistakeBuzz,
  type AudioSettings,
  type Waveform,
} from '../../audio'
import { isNetworkVoice, voiceLabel } from '../../voices'
import { InfoTip, OptionTitle } from './InfoTip'
import {
  MAX_VOICE_POOL,
  MIN_VOICE_POOL,
  pickRandomVoices,
  resolveVoicePool,
  type VoiceOrder,
} from '../../voiceRotation'

interface AudioSectionProps {
  audio: AudioSettings
  setAudio: (v: AudioSettings) => void
  updateAudio: (patch: Partial<AudioSettings>) => void
  ttsVoiceName: string
  setTtsVoiceName: (v: string) => void
  availableVoices: SpeechSynthesisVoice[]
  ttsMultiVoice: boolean
  setTtsMultiVoice: (v: boolean) => void
  ttsVoiceNames: string[]
  setTtsVoiceNames: (v: string[]) => void
  ttsVoicePerSentenceRepeat: boolean
  setTtsVoicePerSentenceRepeat: (v: boolean) => void
  ttsVoicePerWordRepeat: boolean
  setTtsVoicePerWordRepeat: (v: boolean) => void
  ttsVoiceOrder: VoiceOrder
  setTtsVoiceOrder: (v: VoiceOrder) => void
}

/** Settings → AUDIO: dictation voice plus the correct/error feedback sounds. */
export function AudioSection({
  audio,
  setAudio,
  updateAudio,
  ttsVoiceName,
  setTtsVoiceName,
  availableVoices,
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
}: AudioSectionProps) {
  const selectedVoice = availableVoices.find((v) => v.name === ttsVoiceName) ?? null

  // What playback will actually use: names saved on another machine may name
  // voices this browser does not have.
  const resolvedPool = resolveVoicePool(ttsVoiceNames, availableVoices)
  const poolTooSmall = ttsMultiVoice && resolvedPool.length < MIN_VOICE_POOL
  const missingVoices = ttsVoiceNames.filter(
    (name) => !availableVoices.some((v) => v.name === name)
  )
  const poolIsFull = ttsVoiceNames.length >= MAX_VOICE_POOL
  const poolHasCloudVoice = resolvedPool.some(isNetworkVoice)
  // A pool with nothing to rotate against would pin every sentence to one voice.
  const noRotationPicked =
    ttsMultiVoice && !ttsVoicePerSentenceRepeat && !ttsVoicePerWordRepeat

  // Everything wrong with the picked voices, shown in one tooltip beside the list.
  const poolProblems = [
    poolTooSmall &&
      `Pick at least ${MIN_VOICE_POOL} voices. Until then playback uses the single dictation voice above.`,
    missingVoices.length > 0 &&
      `Saved but not offered by this browser, so they are skipped: ${missingVoices.join(', ')}.`,
    poolHasCloudVoice &&
      'A cloud voice is in the pool. Every handover waits on its own network round-trip, which is most noticeable when splitting a sentence.',
  ].filter((p): p is string => Boolean(p))
  const poolWarning =
    poolProblems.length > 0 ? poolProblems.map((p) => <p key={p}>{p}</p>) : undefined

  // Keep the size the pool already has, so pressing Randomize is a re-draw
  // rather than a resize; an unset or under-sized pool fills up to the cap.
  const canRandomize = availableVoices.length >= MIN_VOICE_POOL
  const randomizePool = () => {
    const count =
      ttsVoiceNames.length >= MIN_VOICE_POOL ? ttsVoiceNames.length : MAX_VOICE_POOL
    setTtsVoiceNames(pickRandomVoices(availableVoices, count))
  }

  const toggleVoiceInPool = (name: string) => {
    if (ttsVoiceNames.includes(name)) {
      setTtsVoiceNames(ttsVoiceNames.filter((n) => n !== name))
    } else if (!poolIsFull) {
      setTtsVoiceNames([...ttsVoiceNames, name])
    }
  }

  return (
          <div className="w-full max-w-3xl text-left">
            <h1 className="text-2xl font-bold text-slate-100 mb-2">AUDIO</h1>
            <p className="text-sm text-slate-400 mb-6">
              Feedback sounds during dictation practice. Each can be toggled on or off and has its own volume.
            </p>

            <div className="space-y-6">
              {/* TTS voice */}
              <div className="rounded-lg border border-cyan-500/20 p-4">
                <OptionTitle
                  title="Dictation voice"
                  hint="Voice used to read text lessons aloud."
                  warning={
                    isNetworkVoice(selectedVoice) && !ttsMultiVoice
                      ? 'This voice is synthesized online, so each phrase waits on a network round-trip before it plays. It sounds better but starts slower — for word-by-word practice a local voice is noticeably more responsive.'
                      : undefined
                  }
                  className="mb-3"
                />
                <select
                  value={ttsVoiceName}
                  onChange={(e) => setTtsVoiceName(e.target.value)}
                  className="w-full border border-cyan-500/30 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                >
                  <option value="">Default</option>
                  {availableVoices.map((v) => (
                    <option key={v.name} value={v.name} title={v.name}>
                      {voiceLabel(v)}
                    </option>
                  ))}
                </select>

                {/* Multi-voice */}
                <div className="mt-5 pt-4 border-t border-cyan-500/20">
                  <div className="flex items-center justify-between">
                    <div className="pr-4">
                      <OptionTitle
                        title="Multiple voices per sentence"
                        hint={`Read each sentence with ${MIN_VOICE_POOL}–${MAX_VOICE_POOL} voices instead of one, so your ear does not settle into a single speaker.`}
                      />
                    </div>
                    <label className="inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        className="sr-only peer"
                        checked={ttsMultiVoice}
                        onChange={(e) => setTtsMultiVoice(e.target.checked)}
                      />
                      <div className="relative w-11 h-6 bg-abyss-750 rounded-full peer peer-checked:bg-cyan-600 shadow-glow-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-abyss-800/80 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5"></div>
                    </label>
                  </div>

                  {ttsMultiVoice && (
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="flex items-center gap-1.5 text-xs text-slate-400">
                            Voices ({ttsVoiceNames.length}/{MAX_VOICE_POOL} picked)
                            <InfoTip label="Voice pool problems" warning={poolWarning} />
                          </p>
                          <button
                            type="button"
                            onClick={randomizePool}
                            disabled={!canRandomize}
                            title={
                              canRandomize
                                ? 'Draw a fresh set of voices at random'
                                : `Needs at least ${MIN_VOICE_POOL} voices installed`
                            }
                            className="rounded-lg border border-cyan-500/40 bg-abyss-800/80 px-2.5 py-1 text-xs font-medium text-cyan-200 hover:bg-abyss-750 hover:border-cyan-400/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                          >
                            Randomize
                          </button>
                        </div>
                        <div className="max-h-48 overflow-y-auto rounded-lg border border-cyan-500/20 divide-y divide-cyan-500/10">
                          {availableVoices.map((v) => {
                            const picked = ttsVoiceNames.includes(v.name)
                            const locked = !picked && poolIsFull
                            return (
                              <label
                                key={v.name}
                                title={v.name}
                                className={
                                  locked
                                    ? 'flex items-center gap-3 px-3 py-2 text-sm opacity-40 cursor-not-allowed'
                                    : 'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-abyss-800/60'
                                }
                              >
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  disabled={locked}
                                  onChange={() => toggleVoiceInPool(v.name)}
                                  className="accent-cyan-400"
                                />
                                <span className="text-slate-200">{voiceLabel(v)}</span>
                              </label>
                            )
                          })}
                        </div>
                      </div>

                      <div>
                        <p className="flex items-center gap-1.5 text-xs text-slate-400 mb-2">
                          When the voice changes
                          <InfoTip
                            label="Voice change problem"
                            warning={
                              noRotationPicked
                                ? 'Tick at least one, or there is nothing for the voices to change on and playback stays on the single dictation voice above.'
                                : undefined
                            }
                          />
                        </p>
                        <div className="space-y-2">
                          <label className="flex items-start gap-3 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={ttsVoicePerSentenceRepeat}
                              onChange={(e) => setTtsVoicePerSentenceRepeat(e.target.checked)}
                              className="mt-1 accent-cyan-400"
                            />
                            <span className="inline-flex items-center gap-1.5 text-slate-200">
                              A different voice each repeat
                              <InfoTip label="About A different voice each repeat">
                                One voice reads the whole sentence; the next repeat uses the next
                                voice. Needs Repeat above 1x to be heard.
                              </InfoTip>
                            </span>
                          </label>
                          <label className="flex items-start gap-3 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={ttsVoicePerWordRepeat}
                              onChange={(e) => setTtsVoicePerWordRepeat(e.target.checked)}
                              className="mt-1 accent-cyan-400"
                            />
                            <span className="inline-flex items-center gap-1.5 text-slate-200">
                              A different voice each word repeat
                              <InfoTip label="About A different voice each word repeat">
                                Word-by-word mode only, following its Repeat control: each time a
                                word is spoken again it changes voice, and the rotation carries on
                                into the next word rather than starting over. Can be combined with
                                the setting above.
                              </InfoTip>
                            </span>
                          </label>
                        </div>
                      </div>

                      <div>
                        <p className="text-xs text-slate-400 mb-2">Order</p>
                        <div className="space-y-2">
                          <label className="flex items-center gap-3 text-sm cursor-pointer">
                            <input
                              type="radio"
                              name="multi-voice-order"
                              checked={ttsVoiceOrder === 'fixed'}
                              onChange={() => setTtsVoiceOrder('fixed')}
                              className="accent-cyan-400"
                            />
                            <span className="text-slate-200">In the order I picked</span>
                          </label>
                          <label className="flex items-start gap-3 text-sm cursor-pointer">
                            <input
                              type="radio"
                              name="multi-voice-order"
                              checked={ttsVoiceOrder === 'random'}
                              onChange={() => setTtsVoiceOrder('random')}
                              className="mt-1 accent-cyan-400"
                            />
                            <span className="inline-flex items-center gap-1.5 text-slate-200">
                              Shuffle per sentence
                              <InfoTip label="About Shuffle per sentence">
                                Each sentence gets its own order, kept the same across every
                                repeat of that sentence.
                              </InfoTip>
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Correct sound */}
              <div className="rounded-lg border border-cyan-500/20 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <OptionTitle title="Correct sound" hint="Chime when a sentence is fully correct." />
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={audio.correctEnabled}
                      onChange={(e) => updateAudio({ correctEnabled: e.target.checked })}
                    />
                    <div className="relative w-11 h-6 bg-abyss-750 rounded-full peer peer-checked:bg-cyan-600 shadow-glow-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-abyss-800/80 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5"></div>
                  </label>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(audio.correctVolume * 100)}
                    disabled={!audio.correctEnabled}
                    onChange={(e) => updateAudio({ correctVolume: Number(e.target.value) / 100 })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-10 text-right tabular-nums">{Math.round(audio.correctVolume * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => playCelebrationChime({
                      volume: audio.correctVolume,
                      baseFreq: audio.correctBaseFreq,
                      noteCount: audio.correctNoteCount,
                      noteSpacing: audio.correctNoteSpacing,
                      noteDuration: audio.correctNoteDuration,
                      waveform: audio.correctWaveform,
                    })}
                    disabled={!audio.correctEnabled}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 border border-cyan-500/30 rounded-lg hover:bg-abyss-750 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Test
                  </button>
                </div>

                {/* Waveform */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Waveform</span>
                  <div className="flex gap-1">
                    {WAVEFORMS.map((wf) => (
                      <button
                        key={wf}
                        type="button"
                        disabled={!audio.correctEnabled}
                        onClick={() => updateAudio({ correctWaveform: wf as Waveform })}
                        className={`px-2.5 py-1 text-xs rounded-lg border capitalize transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${audio.correctWaveform === wf
                          ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-300 font-semibold'
                          : 'border-cyan-500/30 bg-abyss-800/80 text-slate-100 hover:bg-abyss-750'
                          }`}
                      >
                        {wf}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Base pitch */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Base Hz</span>
                  <input
                    type="range"
                    min={ERROR_FREQ_MIN}
                    max={ERROR_FREQ_MAX}
                    value={Math.round(audio.correctBaseFreq)}
                    disabled={!audio.correctEnabled}
                    onChange={(e) => updateAudio({ correctBaseFreq: Number(e.target.value) })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{Math.round(audio.correctBaseFreq)} Hz</span>
                </div>

                {/* Note count */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Notes</span>
                  <input
                    type="range"
                    min={NOTE_COUNT_MIN}
                    max={NOTE_COUNT_MAX}
                    step={1}
                    value={audio.correctNoteCount}
                    disabled={!audio.correctEnabled}
                    onChange={(e) => updateAudio({ correctNoteCount: Number(e.target.value) })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{audio.correctNoteCount}</span>
                </div>

                {/* Note spacing */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Spacing</span>
                  <input
                    type="range"
                    min={Math.round(NOTE_SPACING_MIN * 1000)}
                    max={Math.round(NOTE_SPACING_MAX * 1000)}
                    step={10}
                    value={Math.round(audio.correctNoteSpacing * 1000)}
                    disabled={!audio.correctEnabled}
                    onChange={(e) => updateAudio({ correctNoteSpacing: Number(e.target.value) / 1000 })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{Math.round(audio.correctNoteSpacing * 1000)} ms</span>
                </div>

                {/* Note duration */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Ring</span>
                  <input
                    type="range"
                    min={Math.round(ERROR_DURATION_MIN * 1000)}
                    max={Math.round(ERROR_DURATION_MAX * 1000)}
                    step={10}
                    value={Math.round(audio.correctNoteDuration * 1000)}
                    disabled={!audio.correctEnabled}
                    onChange={(e) => updateAudio({ correctNoteDuration: Number(e.target.value) / 1000 })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{Math.round(audio.correctNoteDuration * 1000)} ms</span>
                </div>
              </div>

              {/* Error sound */}
              <div className="rounded-lg border border-cyan-500/20 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <OptionTitle title="Error sound" hint="Buzz on a wrong keystroke." />
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={audio.errorEnabled}
                      onChange={(e) => updateAudio({ errorEnabled: e.target.checked })}
                    />
                    <div className="relative w-11 h-6 bg-abyss-750 rounded-full peer peer-checked:bg-cyan-600 shadow-glow-cyan after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-abyss-800/80 after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-5"></div>
                  </label>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(audio.errorVolume * 100)}
                    disabled={!audio.errorEnabled}
                    onChange={(e) => updateAudio({ errorVolume: Number(e.target.value) / 100 })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-10 text-right tabular-nums">{Math.round(audio.errorVolume * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => playMistakeBuzz({
                      volume: audio.errorVolume,
                      freqStart: audio.errorFreqStart,
                      freqEnd: audio.errorFreqEnd,
                      duration: audio.errorDuration,
                      waveform: audio.errorWaveform,
                    })}
                    disabled={!audio.errorEnabled}
                    className="px-3 py-1.5 text-xs font-medium text-slate-300 border border-cyan-500/30 rounded-lg hover:bg-abyss-750 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Test
                  </button>
                </div>

                {/* Waveform */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Waveform</span>
                  <div className="flex gap-1">
                    {WAVEFORMS.map((wf) => (
                      <button
                        key={wf}
                        type="button"
                        disabled={!audio.errorEnabled}
                        onClick={() => updateAudio({ errorWaveform: wf as Waveform })}
                        className={`px-2.5 py-1 text-xs rounded-lg border capitalize transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${audio.errorWaveform === wf
                          ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-300 font-semibold'
                          : 'border-cyan-500/30 bg-abyss-800/80 text-slate-100 hover:bg-abyss-750'
                          }`}
                      >
                        {wf}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Start frequency */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Start Hz</span>
                  <input
                    type="range"
                    min={ERROR_FREQ_MIN}
                    max={ERROR_FREQ_MAX}
                    value={Math.round(audio.errorFreqStart)}
                    disabled={!audio.errorEnabled}
                    onChange={(e) => updateAudio({ errorFreqStart: Number(e.target.value) })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{Math.round(audio.errorFreqStart)} Hz</span>
                </div>

                {/* End frequency */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">End Hz</span>
                  <input
                    type="range"
                    min={ERROR_FREQ_MIN}
                    max={ERROR_FREQ_MAX}
                    value={Math.round(audio.errorFreqEnd)}
                    disabled={!audio.errorEnabled}
                    onChange={(e) => updateAudio({ errorFreqEnd: Number(e.target.value) })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{Math.round(audio.errorFreqEnd)} Hz</span>
                </div>

                {/* Duration */}
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-slate-400 w-14 shrink-0">Duration</span>
                  <input
                    type="range"
                    min={Math.round(ERROR_DURATION_MIN * 1000)}
                    max={Math.round(ERROR_DURATION_MAX * 1000)}
                    step={10}
                    value={Math.round(audio.errorDuration * 1000)}
                    disabled={!audio.errorEnabled}
                    onChange={(e) => updateAudio({ errorDuration: Number(e.target.value) / 1000 })}
                    className="flex-1 accent-cyan-400 disabled:opacity-40"
                  />
                  <span className="text-xs text-slate-400 w-14 text-right tabular-nums">{Math.round(audio.errorDuration * 1000)} ms</span>
                </div>
              </div>

              <div className="pt-4 border-t border-cyan-500/20 flex items-center justify-end gap-2">
                <InfoTip label="When audio changes apply">
                  Changes apply the next time you open the Workspace.
                </InfoTip>
                <button
                  type="button"
                  onClick={() => { setAudio({ ...AUDIO_DEFAULTS }); saveAudioSettings({ ...AUDIO_DEFAULTS }) }}
                  className="px-3 py-1.5 text-sm font-medium text-slate-300 border border-cyan-500/30 rounded-lg hover:bg-abyss-750"
                >
                  Reset to defaults
                </button>
              </div>
            </div>
          </div>
  )
}
