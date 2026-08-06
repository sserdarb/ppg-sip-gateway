// providers.js — pluggable STT / TTS / LLM layer for the voice concierge.
//
// WHY: the agent used to hard-code Groq-STT → Whisper and Groq-TTS → Google,
// with a single Groq LLM model. A rate-limit or a bad Turkish transcription on
// one vendor degraded the whole call. This module turns each stage into an
// ORDERED CASCADE that is configured by env, so a provider can be added,
// re-ordered or dropped without touching the call logic.
//
// SAFE BY DEFAULT: every provider self-skips when its API key is missing, and
// the default order ends on today's providers. With no new env set, behaviour
// is byte-for-byte what it was before.
//
//   AI_STT_ORDER   default "deepgram,groq,whisper"
//   AI_TTS_ORDER   default "elevenlabs,cartesia,groq,google"
//
// LLM model choice (Groq): llama-3.3-70b-versatile (default, current prod),
// llama-3.1-8b-instant (router / cheap turns), qwen-2.5-72b-instruct and
// llama-3.1-70b-versatile are the alternates worth A/B-ing for Turkish
// grammar + tool-call stability. Set AI_LLM_MODEL_GROQ to switch, and
// AI_LLM_MODEL_FALLBACK for the second attempt on a 429/5xx.

const { ulawToWav, wavToUlaw, pcm16ToUlaw } = require('./audio')

const LOG = (...a) => console.log('[providers]', ...a)

// ── keys ─────────────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || ''
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || ''
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY || ''
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ''
const NVIDIA_KEY = process.env.NVIDIA_API_KEY || ''
const NVIDIA_URL = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
const WHISPER_URL = (process.env.WHISPER_URL || 'http://161.97.132.250:9009').replace(/\/$/, '')

// ── models ───────────────────────────────────────────────────────────────────
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo'
const DEEPGRAM_MODEL = process.env.DEEPGRAM_STT_MODEL || 'nova-2'
const GROQ_LLM_MODEL = process.env.AI_LLM_MODEL_GROQ || process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile'
const GROQ_LLM_FALLBACK = process.env.AI_LLM_MODEL_FALLBACK || 'llama-3.1-8b-instant'
const NVIDIA_LLM_MODEL = process.env.AI_LLM_MODEL || 'meta/llama-3.3-70b-instruct'
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5'
const CARTESIA_MODEL = process.env.CARTESIA_MODEL || 'sonic-2'

const parseOrder = (v, def) => (v || def).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
const STT_ORDER = parseOrder(process.env.AI_STT_ORDER, 'deepgram,groq,whisper')
const TTS_ORDER = parseOrder(process.env.AI_TTS_ORDER, 'elevenlabs,cartesia,groq,google')

/** Parse a JSON env map; `{}` on anything unparseable so a typo can't crash a call. */
function jsonEnv(name) {
  try { return JSON.parse(process.env[name] || '{}') } catch { LOG(`bad JSON in ${name} — ignored`); return {} }
}

// ═══════════════════════════════════════════════════════════════════════════
//  STT
// ═══════════════════════════════════════════════════════════════════════════

// Groq returns the language as a full English name ("Turkish"); the voice
// profiles key off the 2-letter Whisper code.
const LANG_NAME_TO_CODE = {
  turkish: 'tr', english: 'en', german: 'de', russian: 'ru', arabic: 'ar',
  french: 'fr', swedish: 'sv', dutch: 'nl', spanish: 'es', italian: 'it',
}
const toLangCode = (raw) => {
  const s = (raw || '').toLowerCase()
  return LANG_NAME_TO_CODE[s] || s.slice(0, 2)
}

/**
 * Hotel jargon and proper nouns the recogniser otherwise mangles ("Swim-up",
 * "UAI", "Pax", room names, place names). PPG ships the per-hotel list in
 * cc/route → ai.sttVocabulary; this is the always-on baseline.
 */
const BASE_VOCABULARY = [
  'Herşey Dahil', 'Ultra Herşey Dahil', 'Yarım Pansiyon', 'Tam Pansiyon', 'Oda Kahvaltı',
  'UAI', 'AI', 'HB', 'FB', 'BB', 'RO', 'Pax', 'Swim-up', 'Deluxe', 'Suit', 'Junior Suit',
  'Standart Oda', 'Aile Odası', 'Balayı Odası', 'Villa', 'Bungalov',
  'check-in', 'check-out', 'transfer', 'rezervasyon', 'konsept', 'allotment',
  'à la carte', 'açık büfe', 'aquapark', 'spa', 'hamam', 'sauna', 'resepsiyon',
]

/** Merge the baseline with the hotel's own terms; de-duped, capped for the API. */
function buildVocabulary(extra) {
  const list = [...BASE_VOCABULARY, ...(Array.isArray(extra) ? extra : [])]
    .map(s => String(s || '').trim())
    .filter(Boolean)
  return [...new Set(list)].slice(0, 120)
}

/**
 * Deepgram Nova-2 — best Turkish flexibility for hotel jargon because it takes
 * a CUSTOM VOCABULARY. nova-2 uses `keywords=term:boost`, nova-3 renamed it to
 * `keyterm`; both are supported so DEEPGRAM_STT_MODEL can move up freely.
 */
async function deepgramTranscribe(wav, { language, vocabulary }) {
  const qs = new URLSearchParams({ model: DEEPGRAM_MODEL, smart_format: 'true', punctuate: 'true' })
  if (language) qs.set('language', language)
  else qs.set('detect_language', 'true')
  const keyParam = DEEPGRAM_MODEL.startsWith('nova-3') ? 'keyterm' : 'keywords'
  const boost = process.env.DEEPGRAM_KEYWORD_BOOST || '2'
  for (const term of vocabulary) qs.append(keyParam, keyParam === 'keywords' ? `${term}:${boost}` : term)

  const r = await fetch(`https://api.deepgram.com/v1/listen?${qs}`, {
    method: 'POST',
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
    body: wav,
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${(await r.text().catch(() => '')).slice(0, 90)}`)
  const j = await r.json()
  const alt = j?.results?.channels?.[0]?.alternatives?.[0]
  return {
    text: (alt?.transcript || '').trim(),
    language: toLangCode(j?.results?.channels?.[0]?.detected_language || language),
  }
}

/**
 * Groq whisper-large-v3-turbo — ~0.4s round trip. `language` is now PINNED
 * when known (auto-detect on 8kHz telephony audio was a documented source of
 * garbage Turkish) and the vocabulary rides in via `prompt`, which Whisper
 * uses to bias its decoder toward those spellings.
 */
async function groqTranscribe(wav, { language, vocabulary }) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
  form.append('model', GROQ_STT_MODEL)
  form.append('response_format', 'verbose_json')
  if (language) form.append('language', language)
  if (vocabulary.length) form.append('prompt', vocabulary.join(', ').slice(0, 850))
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form, signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`groq stt ${r.status}: ${(await r.text().catch(() => '')).slice(0, 90)}`)
  const j = await r.json()
  return { text: (j.text || '').trim(), language: toLangCode(j.language) || language || '' }
}

/** Self-hosted faster-whisper (last resort; slow on a loaded host but always there). */
async function whisperTranscribe(wav, { language }) {
  const form = new FormData()
  form.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
  const qs = new URLSearchParams({ encode: 'true', task: 'transcribe', output: 'json' })
  if (language) qs.set('language', language)  // unpinned + tiny/small model = garbage Turkish
  const r = await fetch(`${WHISPER_URL}/asr?${qs}`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`whisper ${r.status}`)
  const j = await r.json().catch(() => ({}))
  return { text: (j.text || '').trim(), language: toLangCode(j.language) || language || '' }
}

const STT_IMPL = {
  deepgram: { enabled: () => !!DEEPGRAM_API_KEY, run: deepgramTranscribe },
  groq: { enabled: () => !!GROQ_API_KEY, run: groqTranscribe },
  whisper: { enabled: () => !!WHISPER_URL, run: whisperTranscribe },
}

/**
 * Transcribe one captured utterance.
 * @param {Buffer} ulawFrames  raw µ-law RTP payload
 * @param {object} opts        { language?: 'tr', vocabulary?: string[] }
 * @returns {Promise<{text:string, language:string, provider:string}>}
 */
async function transcribe(ulawFrames, opts = {}) {
  const wav = ulawToWav(ulawFrames)
  const vocabulary = buildVocabulary(opts.vocabulary)
  const language = opts.language || ''
  let lastErr = null
  for (const name of STT_ORDER) {
    const impl = STT_IMPL[name]
    if (!impl || !impl.enabled()) continue
    try {
      const res = await impl.run(wav, { language, vocabulary })
      if (res && res.text) return { ...res, provider: name }
    } catch (e) {
      lastErr = e
      LOG(`stt ${name} failed: ${e.message} — next provider`)
    }
  }
  if (lastErr) LOG('stt: all providers failed, last:', lastErr.message)
  return { text: '', language, provider: 'none' }
}

// ═══════════════════════════════════════════════════════════════════════════
//  TTS
// ═══════════════════════════════════════════════════════════════════════════

// Groq Orpheus voices (terms must be accepted at console.groq.com per model).
// Keyed by the Google voice name so the existing profile list stays canonical.
const GROQ_VOICE_MAP = {
  'en-US-Wavenet-F': { model: 'canopylabs/orpheus-v1-english', voice: 'tara' },
  'en-US-Wavenet-D': { model: 'canopylabs/orpheus-v1-english', voice: 'leo' },
  'ar-XA-Wavenet-A': { model: 'canopylabs/orpheus-arabic-saudi', voice: 'nour' },
  'ar-XA-Wavenet-B': { model: 'canopylabs/orpheus-arabic-saudi', voice: 'hamdan' },
}

// ElevenLabs / Cartesia voice ids are per-account, so they come from env as a
// JSON map keyed by voice-profile id, e.g.
//   ELEVENLABS_VOICE_MAP={"female-tr":"XrExE9y...","male-tr":"pNInz6ob..."}
// A profile with no id simply falls through to the next provider — that is why
// these can be enabled for one language at a time with no risk to the others.
const ELEVEN_VOICE_MAP = jsonEnv('ELEVENLABS_VOICE_MAP')
const CARTESIA_VOICE_MAP = jsonEnv('CARTESIA_VOICE_MAP')

/**
 * ElevenLabs Turbo v2.5 — lowest latency of the premium voices and the most
 * natural Turkish. Asks for `ulaw_8000` so the bytes drop straight into the
 * RTP pacer with no resampling at all.
 */
async function elevenLabsTts(text, { profileId }) {
  const voiceId = ELEVEN_VOICE_MAP[profileId]
  if (!voiceId) throw new Error(`no ElevenLabs voice for profile ${profileId}`)
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000&optimize_streaming_latency=3`,
    {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.0 },
      }),
      signal: AbortSignal.timeout(15000),
    })
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text().catch(() => '')).slice(0, 90)}`)
  return Buffer.from(await r.arrayBuffer())   // already µ-law 8kHz
}

/** Cartesia Sonic — the latency floor; also emits µ-law 8kHz natively. */
async function cartesiaTts(text, { profileId, lang }) {
  const voiceId = CARTESIA_VOICE_MAP[profileId]
  if (!voiceId) throw new Error(`no Cartesia voice for profile ${profileId}`)
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': CARTESIA_API_KEY,
      'Cartesia-Version': process.env.CARTESIA_VERSION || '2024-11-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      language: (lang || 'tr-TR').slice(0, 2),
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`cartesia ${r.status}: ${(await r.text().catch(() => '')).slice(0, 90)}`)
  return Buffer.from(await r.arrayBuffer())   // already µ-law 8kHz
}

/** Groq PlayAI/Orpheus — returns WAV (usually 22050Hz) which we downconvert. */
async function groqTts(text, { voiceName }) {
  const cfg = GROQ_VOICE_MAP[voiceName]
  if (!cfg) throw new Error(`no Groq voice for ${voiceName}`)
  const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: cfg.model, input: text, voice: cfg.voice, response_format: 'wav' }),
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`groq tts ${r.status}: ${(await r.text().catch(() => r.statusText)).slice(0, 80)}`)
  return wavToUlaw(Buffer.from(await r.arrayBuffer()))
}

/** Google Cloud TTS — the always-available floor; asks for MULAW directly. */
async function googleTts(text, { lang, voiceName }) {
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, name: voiceName },
      audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 },
    }),
    signal: AbortSignal.timeout(15000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.audioContent) throw new Error('google tts: ' + JSON.stringify(j).slice(0, 120))
  return Buffer.from(j.audioContent, 'base64')
}

const TTS_IMPL = {
  elevenlabs: { enabled: () => !!ELEVENLABS_API_KEY, run: elevenLabsTts },
  cartesia: { enabled: () => !!CARTESIA_API_KEY, run: cartesiaTts },
  groq: { enabled: () => !!GROQ_API_KEY, run: groqTts },
  google: { enabled: () => !!GOOGLE_TTS_KEY, run: googleTts },
}

/**
 * Synthesize one sentence → 8kHz µ-law bytes.
 * @param {string} text
 * @param {object} profile  { id, lang, voice }  (a voice-profile entry)
 */
async function synthesize(text, profile) {
  const ctx = { profileId: profile.id, lang: profile.lang, voiceName: profile.voice }
  let lastErr = null
  for (const name of TTS_ORDER) {
    const impl = TTS_IMPL[name]
    if (!impl || !impl.enabled()) continue
    try {
      const buf = await impl.run(text, ctx)
      if (buf && buf.length) return buf
    } catch (e) {
      lastErr = e
      // Missing voice-id mappings are the normal "not configured for this
      // language" path — log them quietly so they don't look like outages.
      if (!/no (ElevenLabs|Cartesia|Groq) voice/.test(e.message)) LOG(`tts ${name} failed: ${e.message} — next provider`)
    }
  }
  throw new Error(`all TTS providers failed${lastErr ? `: ${lastErr.message}` : ''}`)
}

// ═══════════════════════════════════════════════════════════════════════════
//  LLM
// ═══════════════════════════════════════════════════════════════════════════

/** Ordered chat endpoints: Groq primary → Groq fallback model → NVIDIA. */
function llmChain() {
  const chain = []
  if (GROQ_API_KEY) {
    chain.push({ name: `groq:${GROQ_LLM_MODEL}`, url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: GROQ_LLM_MODEL })
    if (GROQ_LLM_FALLBACK && GROQ_LLM_FALLBACK !== GROQ_LLM_MODEL)
      chain.push({ name: `groq:${GROQ_LLM_FALLBACK}`, url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: GROQ_LLM_FALLBACK })
  }
  if (NVIDIA_KEY) chain.push({ name: `nvidia:${NVIDIA_LLM_MODEL}`, url: `${NVIDIA_URL}/chat/completions`, key: NVIDIA_KEY, model: NVIDIA_LLM_MODEL })
  return chain
}

/** Emit each COMPLETE sentence from `pending` via onSentence(); return leftover. */
async function emitSentences(pending, onSentence, shouldStop) {
  let out = pending
  while (true) {
    if (shouldStop && shouldStop()) return out
    const m = out.match(/^([\s\S]*?[.!?…]+)([\s\S]*)$/)
    if (!m) break
    const sentence = m[1].trim()
    out = m[2]
    if (sentence) await onSentence(sentence)
  }
  return out
}

/** One streaming attempt against a single endpoint. Returns { text, emitted }. */
async function streamOnce(ep, messages, onSentence, shouldStop, opts) {
  const r = await fetch(ep.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
    body: JSON.stringify({
      model: ep.model, messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 220,
      stream: true,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  })

  if (!r.ok) throw new Error(`${ep.name} ${r.status}`)

  // Non-streaming body (some gateways ignore stream:true) — take it whole.
  if (!r.body || typeof r.body.getReader !== 'function') {
    const j = await r.json().catch(() => ({}))
    const txt = (j.choices?.[0]?.message?.content || '').trim()
    if (txt && !(shouldStop && shouldStop())) await onSentence(txt)
    return { text: txt, emitted: !!txt }
  }

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', full = '', pending = '', emitted = false
  const wrapped = async (s) => { emitted = true; await onSentence(s) }
  while (true) {
    if (shouldStop && shouldStop()) { try { reader.cancel() } catch {} break }
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content || ''
        if (delta) { full += delta; pending += delta }
      } catch {}
    }
    pending = await emitSentences(pending, wrapped, shouldStop)
  }
  const rest = pending.trim()
  if (rest && !(shouldStop && shouldStop())) await wrapped(rest)
  return { text: full.trim(), emitted }
}

/**
 * Stream the reply and fire onSentence() the moment each sentence completes, so
 * TTS for sentence 1 starts while the model is still writing sentence 2.
 *
 * Falls through to the next endpoint on failure ONLY while nothing has been
 * spoken yet — once audio is on the wire, retrying would repeat words at the
 * caller. A 429 on the primary (the documented Groq failure mode) therefore
 * degrades to the smaller model instead of killing the turn.
 */
async function chatStream(messages, onSentence, shouldStop, opts = {}) {
  const chain = llmChain()
  if (!chain.length) throw new Error('no LLM provider configured')
  let spoken = false
  let lastErr = null
  for (const ep of chain) {
    if (spoken) break
    try {
      const res = await streamOnce(ep, messages, onSentence, shouldStop, opts)
      spoken = res.emitted
      if (res.text) return res.text
    } catch (e) {
      lastErr = e
      LOG(`llm ${ep.name} failed: ${e.message}${spoken ? ' (audio already sent, not retrying)' : ' — next model'}`)
      if (spoken) break
    }
  }
  if (lastErr && !spoken) throw lastErr
  return ''
}

/**
 * Non-streaming JSON completion — used by the intent router and by the
 * second pass that turns a tool result into speech. Small models only; keep
 * the timeout tight, a slow answer here is worse than no answer.
 */
async function chatJson(messages, opts = {}) {
  const model = opts.model || GROQ_LLM_FALLBACK
  const chain = GROQ_API_KEY
    ? [{ name: `groq:${model}`, url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model }]
    : llmChain()
  for (const ep of chain) {
    try {
      const r = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({
          model: ep.model, messages,
          temperature: opts.temperature ?? 0,
          max_tokens: opts.maxTokens ?? 200,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
      })
      if (!r.ok) throw new Error(`${ep.name} ${r.status}`)
      const j = await r.json()
      const raw = (j.choices?.[0]?.message?.content || '').trim()
      if (!raw) continue
      // Some models wrap JSON in ```json fences despite response_format.
      const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      return JSON.parse(cleaned)
    } catch (e) {
      LOG(`chatJson ${ep.name} failed: ${e.message}`)
    }
  }
  return null
}

/** One-line health summary for the /health endpoint and boot log. */
function providerStatus() {
  const on = (o, impl) => o.filter(n => impl[n] && impl[n].enabled())
  return {
    stt: { order: STT_ORDER, active: on(STT_ORDER, STT_IMPL) },
    tts: { order: TTS_ORDER, active: on(TTS_ORDER, TTS_IMPL) },
    llm: llmChain().map(e => e.name),
  }
}

module.exports = {
  transcribe, synthesize, chatStream, chatJson, emitSentences,
  buildVocabulary, providerStatus,
  GROQ_LLM_FALLBACK, GROQ_LLM_MODEL,
}
