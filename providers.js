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
 * Whisper INVENTS text when it is given silence or line noise, and it invents
 * the same things every time: the subtitle credits and sign-off phrases that
 * saturate its training data. On a live call one of these came back as
 * "Altyazı M.K." and the agent addressed the guest as "Sayın M.K." for the
 * rest of the conversation.
 *
 * These are matched against the WHOLE utterance — a caller who genuinely says
 * "teşekkürler" mid-sentence must not be silenced, only a turn that consists of
 * nothing but the artefact.
 */
const STT_HALLUCINATIONS = [
  /^alt\s*yazi/,                  // "Altyazı M.K.", "Altyazı: ..."
  /^abone ol/,                    // "Abone olmayı unutmayın"
  /izlediginiz icin tesekkur/,
  /bir sonraki (video|bolum)/,
  /kanalima abone/,
  /^subtitles? by/,
  /^thanks? for watching/,
  /^please subscribe/,
  /^amara\.org/,
  /^[.…·♪♫\-\s]+$/,               // punctuation- or music-only output
]

/**
 * Turkish-aware fold. `ı` is not a JS word character (so `\b` misfires around
 * it) and `İ` does not lowercase to `i` under the `i` flag — matching Turkish
 * with plain regexes silently fails, which is exactly how the first version of
 * this filter passed its own tests and still let "Altyazı M.K." through.
 */
function foldTurkish(s) {
  return String(s)
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/[ıİ]/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
    .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
}

/** True when the utterance is only a known artefact, not speech. */
function isHallucinatedTranscript(text) {
  const t = String(text || '').trim()
  if (!t) return false
  // Long utterances are real speech even if they open with a matching phrase.
  if (t.length > 60) return false
  const folded = foldTurkish(t)
  return STT_HALLUCINATIONS.some(re => re.test(folded))
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
      if (res && res.text) {
        if (isHallucinatedTranscript(res.text)) {
          LOG(`stt ${name} returned a known silence artefact — discarded: ${JSON.stringify(res.text)}`)
          return { text: '', language, provider: name }
        }
        return { ...res, provider: name }
      }
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

/**
 * Google Cloud TTS — the always-available floor; asks for MULAW directly.
 *
 * Chirp3-HD is Google's generative tier and sounds far less mechanical than
 * WaveNet, which is what made the agent read as robotic on the phone. It is
 * available on the existing key (30 Turkish voices) and does emit MULAW 8kHz;
 * it costs ~200ms more per sentence, which sentence-streaming hides.
 *
 * Caveat: Chirp3-HD REJECTS `pitch` ("does not support pitch parameters"), so
 * prosody tuning is limited to speakingRate.
 */
const isChirp = (v) => /-Chirp\d?-?HD-/i.test(v || '')
const SPEAKING_RATE = parseFloat(process.env.AI_TTS_SPEAKING_RATE || '1.0')

async function googleTts(text, { lang, voiceName }) {
  const audioConfig = { audioEncoding: 'MULAW', sampleRateHertz: 8000 }
  if (SPEAKING_RATE && SPEAKING_RATE !== 1.0) audioConfig.speakingRate = SPEAKING_RATE
  // pitch is only safe on the classic voices.
  const pitch = parseFloat(process.env.AI_TTS_PITCH || '0')
  if (pitch && !isChirp(voiceName)) audioConfig.pitch = pitch

  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, name: voiceName },
      audioConfig,
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

/**
 * Ordered chat endpoints.
 *
 * A single vendor is not enough for a phone line. Measured on the live key:
 * Groq's free tier caps `llama-3.3-70b-versatile` at 100k TOKENS PER DAY, and
 * once that is spent every call degrades — while the 8B fallback's entire
 * per-minute budget (6k tokens) is smaller than one request, so it answers 413
 * rather than helping. NVIDIA alone then times out at 20s.
 *
 * So the chain spans VENDORS, not just models: whoever still has budget answers
 * the call. All four speak the OpenAI chat API, so they share one code path.
 * Order via AI_LLM_CHAIN (default "groq,cerebras,openrouter,nvidia").
 */
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || ''
const MISTRAL_MODEL = process.env.MISTRAL_LLM_MODEL || 'mistral-small-latest'
const ZHIPU_KEY = process.env.ZHIPU_API_KEY || ''
// Measured: glm-4-flash / glm-4 / glm-4-air all answer "模型不存在" on this
// account and glm-4-plus is out of balance. glm-4.5-flash is the one that works.
const ZHIPU_MODEL = process.env.ZHIPU_LLM_MODEL || 'glm-4.5-flash'
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || ''
// Valid ids on this account (GET /v1/models): gpt-oss-120b, zai-glm-4.7,
// gemma-4-31b. Measured on the real call script: gpt-oss-120b at
// reasoning_effort=low answers in ~520ms and passes every behavioural check
// (fires the availability tool, one question per turn, no invented price);
// gemma-4-31b returned empty output and zai-glm-4.7 spent its budget reasoning.
const CEREBRAS_MODEL = process.env.CEREBRAS_LLM_MODEL || 'gpt-oss-120b'
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const OPENROUTER_MODEL = process.env.OPENROUTER_LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct'

// CEREBRAS FIRST, measured rather than assumed. Groq's free tier exhausts its
// 100k tokens-per-day and then silently serves the 8B model, which on the real
// call script reads bullet lists aloud and never fires the availability tool —
// a fast wrong answer. Cerebras answers in ~520ms, passes every check, and has
// its own quota. Groq stays second (it is faster when it has budget),
// OpenRouter fourth (~2.2s and currently out of credits).
// Order chosen from MEASURED throughput + Turkish quality, not reputation.
// Every candidate PPG holds a key for was probed on the same Turkish task:
//
//   mistral-small-latest  437ms  clean   50k tokens/min, 50 req/min, NO daily cap
//   groq llama-3.3-70b    287ms  clean   12k tokens/min AND only 100k/day (~30 turns)
//   cerebras gpt-oss-120b 520ms  weak    always up, but leaks English/CJK mid-sentence
//   zhipu glm-4.5-flash  3378ms  clean   works, but 3.4s is a long silence on a call
//   openrouter           2177ms    —     402, out of credits
//   deepseek                 —      —     402, insufficient balance
//   gemini (4 keys)          —      —     429 on every key
//
// MISTRAL LEADS because a phone line needs predictable turns more than it needs
// the last 150ms: Groq is marginally faster and cleaner but 429s for most of the
// day, and a dead primary costs a wasted round trip on every single turn.
const LLM_ORDER = parseOrder(process.env.AI_LLM_CHAIN, 'mistral,groq,cerebras,openrouter,zhipu,nvidia')

function llmChain() {
  const byVendor = {
    groq: () => {
      if (!GROQ_API_KEY) return []
      const url = 'https://api.groq.com/openai/v1/chat/completions'
      const out = [{ name: `groq:${GROQ_LLM_MODEL}`, url, key: GROQ_API_KEY, model: GROQ_LLM_MODEL }]
      if (GROQ_LLM_FALLBACK && GROQ_LLM_FALLBACK !== GROQ_LLM_MODEL) {
        out.push({ name: `groq:${GROQ_LLM_FALLBACK}`, url, key: GROQ_API_KEY, model: GROQ_LLM_FALLBACK })
      }
      return out
    },
    // Cerebras is the latency star (~2000 tok/s) — a good primary for voice.
    // NOTE: its gpt-oss / glm models are REASONING models: they stream
    // `delta.reasoning` before any `delta.content`, so a 160-token budget is
    // spent thinking and the caller hears nothing. Reasoning is wrong for a
    // phone turn anyway (latency), so `reasoning_effort: low` is sent and a
    // non-reasoning model is the default.
    cerebras: () => CEREBRAS_KEY ? [{
      name: `cerebras:${CEREBRAS_MODEL}`,
      url: 'https://api.cerebras.ai/v1/chat/completions',
      key: CEREBRAS_KEY, model: CEREBRAS_MODEL, reasoningEffort: 'low',
    }] : [],
    // The workhorse: 50k tokens AND 50 requests per minute with no daily cap
    // (measured from its own rate-limit headers), clean Turkish, ~440ms. That
    // combination is what a phone line actually needs — Groq is faster and
    // marginally cleaner but runs out after ~30 turns a day.
    mistral: () => MISTRAL_KEY ? [{
      name: `mistral:${MISTRAL_MODEL}`,
      url: 'https://api.mistral.ai/v1/chat/completions',
      key: MISTRAL_KEY, model: MISTRAL_MODEL,
    }] : [],
    openrouter: () => OPENROUTER_KEY ? [{
      name: `openrouter:${OPENROUTER_MODEL}`,
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: OPENROUTER_KEY, model: OPENROUTER_MODEL,
    }] : [],
    // Last resort — works, but ~3.4s is a long silence on a call.
    zhipu: () => ZHIPU_KEY ? [{
      name: `zhipu:${ZHIPU_MODEL}`,
      url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      key: ZHIPU_KEY, model: ZHIPU_MODEL,
    }] : [],
    nvidia: () => NVIDIA_KEY ? [{
      name: `nvidia:${NVIDIA_LLM_MODEL}`,
      url: `${NVIDIA_URL}/chat/completions`,
      key: NVIDIA_KEY, model: NVIDIA_LLM_MODEL,
    }] : [],
  }
  return LLM_ORDER.flatMap(v => (byVendor[v] ? byVendor[v]() : []))
}

/**
 * Emit each COMPLETE sentence from `pending` via onSentence(); return leftover.
 *
 * A period between digits is a THOUSANDS SEPARATOR, not a full stop. Splitting
 * there cut "160.280 TL" into "…160." and "280 TL", and the speech engine read
 * the orphaned "160." as an ordinal — the caller heard "yüz altmışINCI iki yüz
 * seksen". The number never even reached the spell-out pass, because by then it
 * was two different chunks.
 */
const SENTENCE_END = /^([\s\S]*?(?:[!?…]+|(?<!\d)\.+|\.+(?!\d)))([\s\S]*)$/

async function emitSentences(pending, onSentence, shouldStop) {
  let out = pending
  while (true) {
    if (shouldStop && shouldStop()) return out
    const m = out.match(SENTENCE_END)
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
      // NATIVE TOOL CALLING when the caller supplies a schema. Asking a model to
      // emit a magic `[[ACTION {...}]]` string is a coin flip across vendors —
      // measured, Cerebras emitted it reliably and Mistral almost never did,
      // which silently disabled the availability lookup. A declared tool is
      // part of the API contract instead of a formatting habit. The text
      // directive still works as a fallback for endpoints that ignore `tools`.
      ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
      // Live calls came back robotic and repetitive: the same acknowledgements
      // ("Tabii", "Anladım") and the same sentence shapes every turn. 0.4 with
      // no penalties makes a model settle into one groove and stay there.
      // The penalties are what actually break the loop — temperature alone
      // just adds noise, and too much of it invites invented facts.
      temperature: opts.temperature ?? 0.65,
      frequency_penalty: opts.frequencyPenalty ?? 0.5,   // stop reusing words
      presence_penalty: opts.presencePenalty ?? 0.35,    // push toward new ground
      // Two spoken sentences is ~60 tokens; the old 220 left room to ramble
      // into the 4-5 sentence answers heard on the test call.
      max_tokens: opts.maxTokens ?? 160,
      ...(ep.reasoningEffort ? { reasoning_effort: ep.reasoningEffort } : {}),
      stream: true,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
  })

  if (!r.ok) {
    // Carry the vendor's own words: "tokens per day (TPD): Limit 100000, Used
    // 99637" is a completely different problem from "Request too large ... TPM",
    // and a bare status code hides which one you are looking at.
    const detail = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220)
    throw new Error(`${ep.name} ${r.status}${detail ? `: ${detail}` : ''}`)
  }

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
  // Tool-call fragments arrive split across chunks and keyed by index; the
  // arguments are a JSON string built up piece by piece.
  const toolAcc = new Map()
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
        const delta = JSON.parse(data).choices?.[0]?.delta || {}
        if (delta.content) { full += delta.content; pending += delta.content }
        for (const tc of (delta.tool_calls || [])) {
          const i = tc.index ?? 0
          const cur = toolAcc.get(i) || { name: '', args: '' }
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          toolAcc.set(i, cur)
        }
      } catch {}
    }
    pending = await emitSentences(pending, wrapped, shouldStop)
  }
  const rest = pending.trim()
  if (rest && !(shouldStop && shouldStop())) await wrapped(rest)

  if (toolAcc.size && opts.onToolCall) {
    for (const { name, args } of toolAcc.values()) {
      if (!name) continue
      let parsed = {}
      try { parsed = args ? JSON.parse(args) : {} } catch { LOG(`tool args unparseable for ${name}: ${args.slice(0, 120)}`) }
      try { await opts.onToolCall(name, parsed) } catch (e) { LOG('onToolCall err', e.message) }
    }
  }
  return { text: full.trim(), emitted: emitted || toolAcc.size > 0 }
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
  buildVocabulary, providerStatus, isHallucinatedTranscript,
  GROQ_LLM_FALLBACK, GROQ_LLM_MODEL,
}
