// ai-agent.js — Multilingual AI concierge for the AI extension (default 7000).
// caller audio (PCMU/RTP) → energy VAD → Whisper STT (self-hosted, auto language detect)
// → Groq/NVIDIA LLM (responds in caller's language) → Groq PlayAI TTS (EN/AR primary) or Google Cloud TTS (TR/DE/RU + fallback)
// → PCMU/RTP back.

const dgram = require('dgram')
const os = require('os')

function detectIp() {
  const ifs = os.networkInterfaces()
  for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address
  return '127.0.0.1'
}

// ── static config ────────────────────────────────────────────────────────────
const AI_EXT      = process.env.AI_EXTENSION || '7000'
const AI_RTP_PORT = parseInt(process.env.AI_RTP_PORT || '5071', 10)
const PUBLIC_IP   = process.env.AI_RTP_IP || detectIp()
const WHISPER_URL = (process.env.WHISPER_URL || 'http://161.97.132.250:9009').replace(/\/$/, '')
const TTS_KEY     = process.env.GOOGLE_TTS_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ''
const NVIDIA_KEY  = process.env.NVIDIA_API_KEY || ''
const NVIDIA_URL  = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
const LLM_MODEL   = process.env.AI_LLM_MODEL || 'meta/llama-3.3-70b-instruct'
const HOTEL       = process.env.AI_HOTEL_NAME || 'otelimiz'
const LOG = (...a) => console.log('[ai]', ...a)

// ── built-in voice profiles (overridable via constructor) ────────────────────
// Voice genders VERIFIED live against Google TTS voices.list (2026-06-14).
// CRITICAL: tr-TR-Wavenet-E is MALE — it was wrongly used for the "Ayşe" female
// profile, so callers heard a male voice. Female TR = tr-TR-Wavenet-D.
const BUILTIN_PROFILES = [
  { id: 'female-tr', name: 'Ayşe',   gender: 'female', lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-D' },
  { id: 'male-tr',   name: 'Ahmet',  gender: 'male',   lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-B' },
  { id: 'female-en', name: 'Sophie', gender: 'female', lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-F' },
  { id: 'male-en',   name: 'James',  gender: 'male',   lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-D' },
  { id: 'female-de', name: 'Greta',  gender: 'female', lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-F' },
  { id: 'male-de',   name: 'Hans',   gender: 'male',   lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-B' },
  { id: 'female-ru', name: 'Наташа', gender: 'female', lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-A' },
  { id: 'male-ru',   name: 'Иван',   gender: 'male',   lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-B' },
  { id: 'female-sv', name: 'Maja',   gender: 'female', lang: 'sv-SE', whisperCode: 'sv', voice: 'sv-SE-Wavenet-A' },
  { id: 'male-sv',   name: 'Erik',   gender: 'male',   lang: 'sv-SE', whisperCode: 'sv', voice: 'sv-SE-Wavenet-B' },
  { id: 'female-fr', name: 'Claire', gender: 'female', lang: 'fr-FR', whisperCode: 'fr', voice: 'fr-FR-Wavenet-A' },
  { id: 'male-fr',   name: 'Pierre', gender: 'male',   lang: 'fr-FR', whisperCode: 'fr', voice: 'fr-FR-Wavenet-B' },
  { id: 'female-ar', name: 'نور',    gender: 'female', lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-A' },
  { id: 'male-ar',   name: 'عمر',    gender: 'male',   lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-B' },
]

// "Buying time" fillers per language — spoken instantly when the caller stops
// so they hear acknowledgement while STT+LLM run (covers response latency).
// Short, NEUTRAL acknowledgements played the instant the caller stops — they
// fit any turn (chat or lookup) and just signal "I'm with you" while the reply
// is generated. Kept generic on purpose ("checking the system" sounds wrong
// when the caller just said their name).
// Large, varied pools — picked randomly and only occasionally (STT is now ~0.4s
// with Groq, so fillers are rarely needed; rotating 3 phrases sounded repetitive).
const FILLERS = {
  tr: ['Tabii efendim.', 'Hemen bakıyorum.', 'Bir saniye lütfen.', 'Elbette.', 'Memnuniyetle.', 'Tabii ki.', 'Hemen kontrol ediyorum.', 'Şöyle bakalım.'],
  en: ['Of course.', 'One moment please.', 'Let me check.', 'Certainly.', 'Right away.', 'Sure thing.', 'Let me see.'],
  de: ['Natürlich.', 'Einen Moment bitte.', 'Ich schaue gleich.', 'Gerne.', 'Sofort.', 'Mal sehen.'],
  ru: ['Конечно.', 'Минутку, пожалуйста.', 'Сейчас посмотрю.', 'С удовольствием.', 'Один момент.'],
  ar: ['بالتأكيد.', 'لحظة من فضلك.', 'سأتحقق حالًا.', 'بكل سرور.', 'حالًا.'],
  sv: ['Självklart.', 'Ett ögonblick.', 'Jag kollar genast.', 'Visst.', 'Strax.'],
  fr: ['Bien sûr.', 'Un moment, s\'il vous plaît.', 'Je vérifie.', 'Certainement.', 'Tout de suite.'],
}

// VAD / timing
const FRAME_BYTES   = 160
// End-of-turn silence before the AI takes its turn. 500ms cut callers off
// mid-thought ("didn't wait for the answer"); 700ms lets them finish while the
// instant filler keeps it feeling responsive. Tunable via AI_SILENCE_MS.
const SILENCE_MS    = parseInt(process.env.AI_SILENCE_MS || '700', 10)
const MIN_SPEECH_MS = 300
// Cap a single utterance so STT stays fast (Whisper on a loaded host is ~3x
// realtime). 10s keeps transcription bounded. Tunable via AI_MAX_UTTER_MS.
const MAX_UTTER_MS  = parseInt(process.env.AI_MAX_UTTER_MS || '10000', 10)
const VAD_RMS       = parseInt(process.env.AI_VAD_RMS || '500', 10)
// Barge-in (interrupting the AI WHILE it speaks) needs a louder + SUSTAINED
// voice than normal capture — otherwise the AI's own echo on the phone bridge
// (no AEC) trips it and the AI cuts itself off mid-sentence. Tunable.
const BARGE_RMS     = parseInt(process.env.AI_BARGE_RMS || '1100', 10)
const BARGE_MIN_MS  = parseInt(process.env.AI_BARGE_MS  || '320', 10)

// ── G.711 µ-law codec ────────────────────────────────────────────────────────
const ULAW_DECODE = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  let t = ((u & 0x0f) << 3) + 0x84
  t <<= (u & 0x70) >> 4
  ULAW_DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}
function ulawByteToPcm(b) { return ULAW_DECODE[b & 0xff] }

// G.711 µ-law encoder (inverse of ulawByteToPcm) — used for Groq TTS audio conversion
function pcmToUlaw(s) {
  if (s < -32768) s = -32768
  if (s >  32767) s =  32767
  const sign = s < 0 ? 0x80 : 0
  if (sign) s = -s
  s += 0x84
  let exp = 7
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  return (~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f))) & 0xff
}

// Linear resample a PCM16 Buffer from srcRate Hz to dstRate Hz (mono)
function resamplePcm16(buf, srcRate, dstRate) {
  const srcN = buf.length >> 1
  const dstN = Math.floor(srcN * dstRate / srcRate)
  const out  = Buffer.allocUnsafe(dstN * 2)
  const ratio = srcN / dstN
  for (let i = 0; i < dstN; i++) {
    const pos = i * ratio
    const lo  = Math.min(Math.floor(pos), srcN - 1)
    const hi  = Math.min(lo + 1, srcN - 1)
    const a   = buf.readInt16LE(lo * 2)
    const b   = buf.readInt16LE(hi * 2)
    out.writeInt16LE(Math.round(a + (b - a) * (pos - lo)), i * 2)
  }
  return out
}

// Parse RIFF/WAV bytes → { pcm (PCM16 LE), sampleRate, channels, bitsPerSample }
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV')
  let pos = 12, sampleRate = 0, channels = 1, bitsPerSample = 16, dataOff = 0, dataLen = 0
  while (pos < buf.length - 8) {
    const tag  = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (tag === 'fmt ') {
      channels      = buf.readUInt16LE(pos + 10)
      sampleRate    = buf.readUInt32LE(pos + 12)
      bitsPerSample = buf.readUInt16LE(pos + 22)
    } else if (tag === 'data') {
      dataOff = pos + 8
      dataLen = size
      break
    }
    pos += 8 + (size & ~1)  // chunks are word-aligned
  }
  if (!sampleRate || !dataOff) throw new Error('WAV parse failed')
  return { pcm: buf.subarray(dataOff, dataOff + dataLen), sampleRate, channels, bitsPerSample }
}

// ── tiny WAV writer ──────────────────────────────────────────────────────────
function pcm16ToWav(pcmBuf, rate = 8000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBuf.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcmBuf.length, 40)
  return Buffer.concat([h, pcmBuf])
}

// ── external AI calls ────────────────────────────────────────────────────────
/** Returns { text, language } — language is Whisper's BCP-like 2-letter code e.g. 'tr','en' */
async function whisperTranscribe(ulawFrames) {
  const pcm = Buffer.alloc(ulawFrames.length * 2)
  for (let i = 0; i < ulawFrames.length; i++) pcm.writeInt16LE(ulawByteToPcm(ulawFrames[i]), i * 2)
  const wav = pcm16ToWav(pcm, 8000)
  const form = new FormData()
  form.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
  // No language= param → Whisper auto-detects and returns it in response
  const url = `${WHISPER_URL}/asr?encode=true&task=transcribe&output=json`
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
  const j = await r.json().catch(() => ({}))
  return { text: (j.text || '').trim(), language: (j.language || '').toLowerCase() }
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo'

/** Groq STT — ultra-fast cloud Whisper. ~1s vs ~20s self-hosted on a loaded
 *  host. Used automatically when GROQ_API_KEY is set; falls back to local. */
async function groqTranscribe(ulawFrames) {
  const pcm = Buffer.alloc(ulawFrames.length * 2)
  for (let i = 0; i < ulawFrames.length; i++) pcm.writeInt16LE(ulawByteToPcm(ulawFrames[i]), i * 2)
  const wav = pcm16ToWav(pcm, 8000)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
  form.append('model', GROQ_STT_MODEL)
  form.append('response_format', 'verbose_json') // includes detected language
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form, signal: AbortSignal.timeout(15000),
  })
  const j = await r.json().catch(() => ({}))
  // Groq returns the language as a full name ("Turkish"/"English"); map to the
  // 2-letter whisperCode the voice profiles use (else it'd become "tu", "en"…).
  const LANG_MAP = { turkish: 'tr', english: 'en', german: 'de', russian: 'ru', arabic: 'ar' }
  const raw = (j.language || '').toLowerCase()
  return { text: (j.text || '').trim(), language: LANG_MAP[raw] || raw.slice(0, 2) }
}

/** STT dispatcher: Groq (fast) when configured, else self-hosted Whisper.
 *  Falls back to Whisper if Groq errors so a key issue never kills the call. */
async function transcribe(ulawFrames) {
  if (GROQ_API_KEY) {
    try {
      const g = await groqTranscribe(ulawFrames)
      if (g.text) return g
    } catch (e) { LOG('groq stt err, falling back to whisper:', e.message) }
  }
  return whisperTranscribe(ulawFrames)
}

// Emit each COMPLETE sentence from `pending` via onSentence(); return leftover.
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

/**
 * Stream the LLM reply token-by-token and fire onSentence() the moment each
 * sentence completes — so TTS + playback of sentence 1 begin while the model
 * is still generating sentence 2. This is the main latency win: first audio
 * lands seconds earlier than waiting for the whole completion. Returns the
 * full text (to push into history). Falls back to a single non-streamed chunk
 * if the stream can't be opened.
 */
async function llmStream(history, onSentence, shouldStop) {
  // Prefer Groq (≈0.4s first token even with a large prompt) over NVIDIA
  // (≈6.5s first token, which overran the timeout → "LLM timeout" on calls).
  const useGroq = !!GROQ_API_KEY
  const url = useGroq ? 'https://api.groq.com/openai/v1/chat/completions' : `${NVIDIA_URL}/chat/completions`
  const key = useGroq ? GROQ_API_KEY : NVIDIA_KEY
  const model = useGroq ? (process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile') : LLM_MODEL
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: history, temperature: 0.4, max_tokens: 220, stream: true }),
    signal: AbortSignal.timeout(20000),
  })

  if (!r.ok || !r.body || typeof r.body.getReader !== 'function') {
    const j = await r.json().catch(() => ({}))
    const txt = (j.choices?.[0]?.message?.content || '').trim()
    if (txt && !(shouldStop && shouldStop())) await onSentence(txt)
    return txt
  }

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = '', full = '', pending = ''
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
    pending = await emitSentences(pending, onSentence, shouldStop)
  }
  const rest = pending.trim()
  if (rest && !(shouldStop && shouldStop())) await onSentence(rest)
  return full.trim()
}

// ── TTS ──────────────────────────────────────────────────────────────────────
// Groq Orpheus TTS voice map: Google voice name → { model, voice }
// Requires terms acceptance at console.groq.com for each model.
// TR/DE/RU always go to Google TTS; EN/AR try Groq first then fall back to Google.
const GROQ_VOICE_MAP = {
  'en-US-Wavenet-F': { model: 'canopylabs/orpheus-v1-english',    voice: 'tara'   },  // female-en
  'en-US-Wavenet-D': { model: 'canopylabs/orpheus-v1-english',    voice: 'leo'    },  // male-en
  'ar-XA-Wavenet-A': { model: 'canopylabs/orpheus-arabic-saudi',  voice: 'nour'   },  // female-ar
  'ar-XA-Wavenet-B': { model: 'canopylabs/orpheus-arabic-saudi',  voice: 'hamdan' },  // male-ar
}

/** Groq PlayAI TTS → MULAW 8kHz raw bytes.
 *  Groq returns WAV (PCM16, typically 22050 Hz) which we resample + encode. */
async function groqTtsUlaw(text, groqModel, groqVoice) {
  const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: groqModel, input: text, voice: groqVoice, response_format: 'wav' }),
    signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) {
    const e = await r.text().catch(() => r.statusText)
    throw new Error(`Groq TTS ${r.status}: ${e.slice(0, 80)}`)
  }
  const wav = Buffer.from(await r.arrayBuffer())
  const { pcm, sampleRate, channels, bitsPerSample } = parseWav(wav)
  // Mix stereo → mono if needed
  let mono = pcm
  if (channels === 2 && bitsPerSample === 16) {
    mono = Buffer.allocUnsafe(pcm.length >> 1)
    for (let i = 0, o = 0; i < pcm.length; i += 4, o += 2)
      mono.writeInt16LE((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) >> 1, o)
  }
  const pcm8k = sampleRate === 8000 ? mono : resamplePcm16(mono, sampleRate, 8000)
  const ulaw  = Buffer.allocUnsafe(pcm8k.length >> 1)
  for (let i = 0; i < ulaw.length; i++) ulaw[i] = pcmToUlaw(pcm8k.readInt16LE(i * 2))
  return ulaw
}

/** TTS dispatcher → MULAW 8kHz.
 *  Groq PlayAI is tried first for EN/AR (faster, free, no per-char billing).
 *  Google Cloud TTS handles TR/DE/RU and is the fallback for all languages. */
async function ttsUlaw(text, lang, voiceName) {
  const groqCfg = GROQ_API_KEY && GROQ_VOICE_MAP[voiceName]
  if (groqCfg) {
    try { return await groqTtsUlaw(text, groqCfg.model, groqCfg.voice) }
    catch (e) { LOG('groq tts err, fallback google:', e.message) }
  }
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, name: voiceName },
      audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 },
    }),
    signal: AbortSignal.timeout(15000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.audioContent) throw new Error('TTS: ' + JSON.stringify(j).slice(0, 120))
  return Buffer.from(j.audioContent, 'base64')
}

// Build the pricing rules block injected into the system prompt. With a live
// priceContext (room types, concepts, future-only prices) the AI enumerates
// real options and never quotes a past date. Without it, it still refuses
// past dates and won't invent prices.
function buildPriceBlock(pc) {
  const today = (pc && pc.today) || new Date().toISOString().slice(0, 10)
  if (pc && Array.isArray(pc.roomTypes) && pc.roomTypes.length) {
    const priceLines = (pc.prices || [])
      .map(p => `  - ${p.roomType} / ${p.concept}: ${p.from} ${p.currency}'dan başlayan gece fiyatı (geçerli: ${p.validFrom} → ${p.validTo})`)
      .join('\n')
    return (
      `\n\n=== FİYAT & ODA BİLGİSİ ===` +
      `\nBUGÜNÜN TARİHİ: ${today}. Bu tarihten ÖNCEKİ hiçbir tarih için fiyat verme.` +
      `\nODA TİPLERİ: ${pc.roomTypes.join(', ')}.` +
      `\nKONSEPTLER: ${pc.concepts.join(', ')}.` +
      (priceLines ? `\nGÜNCEL FİYAT LİSTESİ (gece başı):\n${priceLines}` : '') +
      `\nKURALLAR:` +
      `\n1) Müşteri fiyat sorduğunda mevcut oda tiplerini TEK TEK say ve her birinin konseptini (pansiyon) belirt.` +
      `\n2) Fiyat vermeden önce giriş ve çıkış tarihini ve kişi sayısını öğren.` +
      `\n3) Geçmiş bir tarih istenirse fiyat verme; "geçmiş tarih için fiyat veremiyorum, güncel tarihlerde yardımcı olayım" de.` +
      `\n4) Listede olmayan oda/tarih için fiyat UYDURMA; bir yetkiliye aktarmayı öner.`
    )
  }
  return (
    `\n\n=== FİYAT KURALI ===` +
    `\nBUGÜNÜN TARİHİ: ${today}. Geçmiş tarih için fiyat verme.` +
    ` Sistemde güncel fiyat tanımlı değil; fiyat UYDURMA. Giriş-çıkış tarihi ile kişi sayısını al, oda tiplerini tek tek say ve kesin fiyat için bir yetkiliye aktarmayı öner.`
  )
}

// Build the hotel-facts block injected into the system prompt so the AI
// describes the property from REAL data (hotel record + concierge KB), not
// invention. Empty string when no info is available.
function buildHotelBlock(h) {
  if (!h) return ''
  const lines = ['\n\n=== OTEL BİLGİLERİ (oteli SADECE bunlarla anlat, uydurma) ===']
  if (h.name) {
    const loc = [h.city, h.country].filter(Boolean).join(', ')
    lines.push(`Otel: ${h.name}${h.stars ? ` (${h.stars} yıldız)` : ''}${loc ? `, ${loc}` : ''}.`)
  }
  if (h.concept)   lines.push(`Konsept: ${h.concept}.`)
  if (h.address)   lines.push(`Adres: ${h.address}.`)
  if (h.website)   lines.push(`Web sitesi: ${h.website}.`)
  if (Array.isArray(h.amenities) && h.amenities.length) lines.push(`Olanaklar: ${h.amenities.join(', ')}.`)
  if (Array.isArray(h.kb) && h.kb.length) {
    lines.push('Doğrulanmış bilgiler (sık sorulanlar):')
    for (const e of h.kb) lines.push(`- ${e.q ? e.q + ': ' : ''}${e.a}`)
  }
  // Free-text training document edited by the hotel in the admin panel.
  if (h.trainingDoc && h.trainingDoc.trim()) {
    lines.push('\n--- EĞİTİM DÖKÜMANI (otelin hazırladığı bilgi) ---')
    lines.push(h.trainingDoc.trim())
  }
  lines.push('\nOtel hakkında konuşurken yukarıdaki bilgileri kullan; emin olmadığını uydurma, gerekiyorsa yetkiliye aktarmayı öner.')
  return lines.join('\n')
}

// ── one live AI call ─────────────────────────────────────────────────────────
class AiCall {
  /**
   * @param {object} opts
   * @param {string}  opts.remoteIp
   * @param {number}  opts.remotePort
   * @param {Function} opts.onBye
   * @param {string}  [opts.greetingOverride]   — per-trunk greeting text
   * @param {string}  [opts.agentName]          — display name of the AI agent
   * @param {Array}   [opts.voiceProfiles]       — [{id,lang,whisperCode,voice,...}]
   * @param {string}  [opts.defaultVoiceProfileId] — which profile to start with
   * @param {object}  [opts.priceContext]          — { today, currency, roomTypes[], concepts[], prices[] }
   * @param {object}  [opts.hotelInfo]             — { name, city, country, stars, concept, website, amenities[], kb[] }
   */
  constructor({ remoteIp, remotePort, onBye, greetingOverride, agentName, voiceProfiles, defaultVoiceProfileId, priceContext, hotelInfo, hotelId, callId, caller, onEnd, onAction } = {}) {
    this.remoteIp   = remoteIp
    this.remotePort = remotePort
    this.onBye      = onBye
    // Call metadata for the post-call lead record (name/phone capture).
    this.hotelId    = hotelId || null
    this.callId     = callId || null
    this.caller     = caller || null
    this.onEnd      = onEnd || null
    this.onAction   = onAction || null   // executes [[ACTION {...}]] directives (offer/transfer)
    this.startedAt  = Date.now()
    this._reported  = false

    // Resolve voice profiles
    this.profiles = (Array.isArray(voiceProfiles) && voiceProfiles.length)
      ? voiceProfiles : BUILTIN_PROFILES
    const defId = defaultVoiceProfileId || 'female-tr'
    this.currentProfile = this.profiles.find(p => p.id === defId) || this.profiles[0]
    // Lock the operator-selected gender — language auto-switch keeps this gender
    // so a female agent never flips to a male voice mid-call (and vice-versa).
    this.lockedGender = this.currentProfile.gender || (this.currentProfile.id.startsWith('male') ? 'male' : 'female')

    // Agent identity
    this.agentName = agentName || this.currentProfile.name || 'Asistan'
    const hotel = HOTEL === 'otelimiz' ? 'otelimiz' : HOTEL

    // Greeting
    const defaultGreeting = `${hotel} çağrı merkezine hoş geldiniz, ben ${this.agentName}. Size nasıl yardımcı olabilirim?`
    this._greeting = greetingOverride || defaultGreeting

    // Pricing + hotel-info blocks — injected from PPG (real data).
    const priceBlock = buildPriceBlock(priceContext)
    const hotelBlock = buildHotelBlock(hotelInfo)

    // Master persona + operating rules — encodes the hotel call-center AI
    // training document (persona, tone, red lines, workflow, hand-off). Live
    // priceBlock + hotelBlock are ALWAYS appended (even when AI_SYSTEM_PROMPT
    // overrides the base) so real pricing/hotel facts can't be lost.
    const hotelName = (hotelInfo && hotelInfo.name) || hotel
    const basePrompt = process.env.AI_SYSTEM_PROMPT ||
      `Sen ${hotelName} otelinin resmi, profesyonel, misafirperver ve empatik Yapay Zeka Çağrı Merkezi Asistanı ${this.agentName}'sın. Görevin: rezervasyon talebi almak, sık sorulan soruları yanıtlamak, temel sorunları çözmek ve resepsiyon/satış ekibinin yükünü azaltmak. Robotik ve soğuk konuşmazsın; sorulursa yapay zeka olduğunu saklamazsın.` +

      `\n\nDİL: Arayan hangi dilde konuşuyorsa SEN DE O DİLDE yanıt ver (Türkçe, İngilizce, Almanca, Rusça, Arapça). Her zaman "Siz" diliyle, saygılı hitap et; adını öğrenince "Ahmet Bey / Ayşe Hanım" şeklinde seslen.` +
      `\n\nDİL KALİTESİ (ÇOK ÖNEMLİ): SADECE düzgün, akıcı ve dilbilgisi doğru yanıt yaz. Başka dilden kelime KARIŞTIRMA (Türkçe konuşurken İngilizce kelime kullanma). İmlaya, oda adlarına ve sayılara dikkat et; uydurma/bozuk kelime yazma. Sesli okunacağı için cümleler temiz ve telaffuz edilebilir olmalı.` +

      `\n\nKONUŞMA DÜZENİ (telefon — ÇOK ÖNEMLİ): Yanıtların ÇOK KISA olsun (1-3 cümle) ve sözü karşı tarafa bırak. Her turda SADECE tek bir şey söyle veya tek bir soru sor, sonra SUS ve cevabı BEKLE; aynı anda iki soru sorma, soru sorup başka konuya geçme. Misafir kendi sorusunu sorarsa ÖNCE ona cevap ver, kendi sıranı sonra sürdür. Söylediğini tekrarlama.` +

      `\n\nTON: Pozitif çerçevele — "yok / hayır / yapamayız" gibi keskin negatiflerden kaçın. Örn. "o tarihlerde boş oda yok" yerine "belirttiğiniz tarihlerde doluyuz efendim, dilerseniz alternatif tarihlere bakabilirim". Şikayet/sorun anında önce EMPATİ kur ("Bu durumu yaşadığınız için üzgünüm, sizi anlıyorum"), savunmaya geçme.` +

      `\n\nKIRMIZI ÇİZGİLER:` +
      `\n- Bilgi UYDURMA: bilgi bankasında/sistemde olmayan fiyat, kampanya veya özelliği söyleme. Bilmiyorsan "Bu konudaki güncel bilgiye şu an erişemiyorum, sizi yetkili arkadaşıma aktarıyorum" de.` +
      `\n- Kredi kartı numarası veya CVV'yi ASLA sesli isteme. Ödeme yalnızca misafirin telefonuna gönderilen güvenli ödeme linkiyle yapılır.` +
      `\n- Resepsiyon inisiyatifindeki konulara KESİN söz verme (örn. erken giriş): "talebinizi sisteme not alıyorum, giriş günü müsaitliğe göre arkadaşlarımız yardımcı olur" de.` +
      `\n- Rezervasyonu kesinleştirmeden ÖNCE giriş-çıkış tarihi, kişi sayısı ve toplam tutarı özetle ve sesli ONAY al ("Onaylıyor musunuz?").` +

      `\n\nİŞ AKIŞI (her turda tek adım, cevabı alıp devam et): 1) Karşıla, numara tanınıyorsa isimle hitap et. 2) Niyeti anla (yeni rezervasyon / iptal-değişiklik / bilgi / şikayet). 3) Rezervasyonsa giriş-çıkış tarihi ve yetişkin/çocuk sayısını eksiksiz öğren. 4) Müsaitlik ve fiyatı sun. 5) Fırsat varsa küçük bir farkla daha iyi bir oda öner (örn. deniz manzaralı). 6) Özetle, ödeme linkini ilet ve "Başka yardımcı olabileceğim bir konu var mı?" diyerek kapat.` +

      `\n\nİNSANA AKTARIM: Şu durumlarda inisiyatif alma; "Size daha iyi yardımcı olabilmesi için sizi konunun uzmanı arkadaşıma aktarıyorum, lütfen kısa süre hatta kalın" deyip aktar: misafir sinirli/argo/çok gergin; açıkça "insana/müşteri temsilcisine bağla" derse; düğün, toplantı salonu, 5+ oda grup talebi; üst üste 2 kez anlayamazsan; sisteme ulaşılamayıp anlık fiyat çekilemezse.` +

      `\n\nBEKLEME: Sistemden veri çekerken misafiri sessiz bırakma; "Hemen sistemden kontrol ediyorum, lütfen hatta kalın" gibi kısa dolgu cümlesi kullan. Sıcak ve doğal konuş.`

    // Action directives — the AI triggers real system actions by emitting ONE
    // machine line at the VERY END of its reply. The gateway executes it and
    // strips it from speech (it is never read aloud).
    const actionBlock =
      `\n\n=== SİSTEM AKSİYONLARI (sesli okunmaz, yalnız sistem için) ===` +
      `\nBir aksiyon gerektiğinde, cevabının EN SONUNA tek satır olarak şu formatta yaz (kullanıcıya bundan bahsetme, normal cümleyle de söyle):` +
      `\n• Ödeme linki gönderme (misafir kabul edip iletişim verince): [[ACTION {"type":"send_offer","channel":"email","guestName":"<ad>","guestEmail":"<e-posta>","guestPhone":"<telefon>","room":"<oda tipi>","total":<sayı>,"currency":"<EUR|TRY>","checkIn":"<YYYY-AA-GG>","checkOut":"<YYYY-AA-GG>","adults":<sayı>}]]  (channel: email | whatsapp; e-posta için email iste, WhatsApp için telefon yeterli)` +
      `\n• İnsana/dahiliyeye aktarma (öfke, "insana bağla", grup/5+ oda/düğün/toplantı, 2 kez anlamama, sistem arızası): [[ACTION {"type":"transfer"}]]` +
      `\nKURAL: total ve currency'yi MUTLAKA verdiğin fiyattan al; uydurma. E-posta yoksa channel=whatsapp kullan. Aksiyon satırını yalnız gerçekten gerektiğinde ekle.`

    // Conversation playbook — 30+ natural patterns the AI draws from based on
    // what the caller says. NEVER repeat the same phrasing; improvise around
    // these, don't read them verbatim. Keeps the call human + corporate.
    const playbookBlock =
      `\n\n=== DOĞAL KONUŞMA İLKELERİ ===` +
      `\n- ASLA aynı kalıbı/aynı kelimeleri tekrarlama. Her cevabı farklı kur. "Anladım", "Tabii" gibi onayları arka arkaya kullanma; çeşitlendir veya hiç kullanma, doğrudan konuya gir.` +
      `\n- Kurumsal ama samimi, akıcı ve doğal konuş; ezbere/robotik olma. Aşağıdaki kalıplar SADECE ilham; kelimesi kelimesine okuma, kendi cümlelerinle doğaçla.` +
      `\n- Misafirin söylediğine göre uygun kalıbı seç. Kısa tut, sonra soruyu karşıya bırak.` +
      `\n\n=== DİYALOG KALIPLARI (ilham — çeşitlendir) ===` +
      `\n[Karşılama] "…'a hoş geldiniz, ben ${this.agentName}." / "Bugün size nasıl yardımcı olabilirim?" / "Hoş geldiniz, sizi dinliyorum."` +
      `\n[İsim alma] "Öncelikle adınızı öğrenebilir miyim?" / "Kiminle görüşüyorum acaba?" / "Size nasıl hitap edeyim?"` +
      `\n[Hal hatır] "Nasılsınız bugün?" / "Umarım gününüz güzel geçiyordur." / (kötüyse) "Geçmiş olsun, umarım kısa sürede toparlarsınız."` +
      `\n[Tarih/kişi öğrenme] "Hangi tarihler için düşünüyorsunuz?" / "Kaç gece ve kaç kişi konaklayacaksınız?" / "Giriş ve çıkış tarihiniz nedir?"` +
      `\n[Fiyat sunma] "… oda tipimiz, … konseptiyle gecelik … TL'den başlıyor." / "Bu tarihler için en uygun seçeneğimiz şu…" / "Size birkaç alternatif vereyim…"` +
      `\n[Oda tipleri] "Standart, Aile, Deluxe ve Suit seçeneklerimiz var; hangisi ilginizi çeker?" / "Deniz manzaralı odalarımız da mevcut." / "Kaç kişilik bir oda arıyorsunuz?"` +
      `\n[Oda özelliği] "Odalarımızda klima, mini bar, balkon ve ücretsiz Wi-Fi bulunur." / "… m² genişliğinde, … manzaralı."` +
      `\n[Konsept/pansiyon] "Her Şey Dahil konseptimizde tüm öğünler ve seçili içecekler dahildir." / "Ultra Her Şey Dahil'de à la carte restoranlar da kapsamda."` +
      `\n[Konum] "Otelimiz … bölgesinde, plaja sıfır." / "Havaalanına yaklaşık … dakika mesafedeyiz." / "Şehir merkezine … km uzaktayız."` +
      `\n[Ulaşım/transfer] "Havaalanı transferi düzenleyebiliyoruz, ister misiniz?" / "Özel araçla geliyorsanız ücretsiz otoparkımız var."` +
      `\n[Plaj/havuz] "Özel plajımız ve … havuzumuz mevcut." / "Aquapark ve çocuk havuzumuz da var."` +
      `\n[Çocuk] "Çocuk kulübümüz … yaş arası misafirlerimize hizmet veriyor." / "… yaşına kadar çocuklar ücretsiz konaklıyor."` +
      `\n[Spa/wellness] "Spa merkezimizde hamam, sauna ve masaj hizmetleri var." / "Fitness salonumuz 24 saat açık."` +
      `\n[Yeme-içme] "Ana restoranımız açık büfe; ayrıca à la carte restoranlarımız mevcut." / "Özel beslenme/diyet talebinizi not edebiliriz."` +
      `\n[Müsaitlik] "Bu tarihlerde müsaitliğimiz var, hemen ayırtabiliriz." / (yoksa) "O tarihler dolu görünüyor; çok yakın bir tarihe alternatif bakayım mı?"` +
      `\n[Ek satış] "Çok küçük bir farkla deniz manzaralı odaya geçebilirsiniz, ister misiniz?" / "Balayı paketimiz de mevcut."` +
      `\n[Teklif/ödeme] "Size özel teklifi telefonunuza/e-postanıza ödeme linkiyle gönderebilirim." / "Linkten güvenle ödeyince rezervasyonunuz kesinleşir."` +
      `\n[Teyit] "Özetleyeyim: … tarihleri, … kişi, … oda, toplam … TL. Onaylıyor musunuz?"` +
      `\n[İtiraz/pahalı] "Anlıyorum; daha uygun bir oda tipi ya da farklı tarih önerebilirim." / "Erken rezervasyon avantajımız olabilir, kontrol edeyim."` +
      `\n[Şikayet] "Bu durumu yaşadığınız için üzgünüm, hemen ilgileniyorum." / "Sizi anlıyorum, en kısa sürede çözelim."` +
      `\n[Bilmediğinde] "Bu detayı kesinleştirmem için bir yetkiliye aktarayım." / "Emin olmak adına ilgili arkadaşıma bağlıyorum."` +
      `\n[Kapanış] "Başka yardımcı olabileceğim bir konu var mı?" / "Aradığınız için teşekkürler, iyi günler dilerim." / "Sizi otelimizde ağırlamak isteriz."`
    this.systemPrompt = basePrompt + priceBlock + hotelBlock + playbookBlock + actionBlock

    // Filler ("buying time") phrases — pre-synthesized so the AI acknowledges
    // instantly the moment the caller stops talking, covering STT+LLM latency.
    this.fillerCache = new Map()  // voiceName → Map(text → ulawBuffer)
    this.fillerIdx = 0

    this.seq  = (Math.random() * 0xffff) | 0
    this.ts   = (Math.random() * 0xffffffff) >>> 0
    this.ssrc = (Math.random() * 0xffffffff) >>> 0
    this.playQueue  = []
    this.speaking   = false
    this.history    = [{ role: 'system', content: this.systemPrompt }]
    this.utter      = []
    this.inSpeech   = false
    this.speechMs   = 0
    this.silenceMs  = 0
    this.busy       = false
    this.closed     = false
    // TTS pipeline: start fetches in parallel, queue audio in sentence order.
    // _pendingTts tracks how many TTS fetches are in-flight so tick() knows
    // not to flip speaking=false while more audio is about to arrive.
    this._sayChain   = Promise.resolve()
    this._pendingTts = 0
    this.bargeMs     = 0   // consecutive loud-input ms while AI speaks (barge-in)

    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (m) => this.onRtp(m))
    this.sock.on('error', (e) => LOG('rtp sock err', e.message))
    this.sock.bind(AI_RTP_PORT, '0.0.0.0', () =>
      LOG(`RTP bound :${AI_RTP_PORT} peer=${remoteIp}:${remotePort} profile=${this.currentProfile.id}`))

    this.pacer = setInterval(() => this.tick(), 20)
    // Greeting: wait ~900ms for the PBX/rtpengine media path to settle, then
    // push ~300ms of lead-in silence so the first syllable isn't clipped
    // (early frames can be dropped before the remote starts accepting RTP).
    setTimeout(() => {
      if (this.closed) return
      for (let i = 0; i < 15; i++) this.playQueue.push(SILENCE_FRAME)
      this.speaking = true
      this.say(this._greeting)
    }, 900)
    // Warm one filler for the starting voice so the first turn is instant.
    this.prewarmFiller()
  }

  /**
   * Pre-synthesize ALL fillers for the current voice so playFiller() can push
   * synchronously from cache (no await → no reordering vs the streamed reply).
   * Non-blocking; safe to call again after a language/voice switch.
   */
  async prewarmFiller() {
    const { lang, voice, whisperCode } = this.currentProfile
    const list = FILLERS[whisperCode] || FILLERS.tr
    let cache = this.fillerCache.get(voice)
    if (!cache) { cache = new Map(); this.fillerCache.set(voice, cache) }
    for (const text of list) {
      if (cache.has(text)) continue
      try { cache.set(text, await ttsUlaw(text, lang, voice)) } catch (e) { LOG('filler prewarm err', e.message) }
    }
  }

  /**
   * Play a short "buying time" filler immediately. Pushes synchronously from
   * the pre-warmed cache (so it lands BEFORE the streamed reply); if not yet
   * cached, fetches in the background and warms for next time.
   */
  playFiller() {
    const { voice, whisperCode } = this.currentProfile
    const list = FILLERS[whisperCode] || FILLERS.tr
    // Random pick, never the same as last time → no repetition.
    let idx = Math.floor(Math.random() * list.length)
    if (list.length > 1 && idx === this._lastFiller) idx = (idx + 1) % list.length
    this._lastFiller = idx
    const text = list[idx]
    const cache = this.fillerCache.get(voice)
    const ulaw = cache && cache.get(text)
    if (ulaw) {
      if (this.closed || this.cancelResponse) return
      this._enqueue(ulaw)
      this.speaking = true
    } else {
      // Cache miss (e.g. right after a language switch) — warm for next turn.
      this.prewarmFiller().catch(() => {})
    }
  }

  /**
   * Switch to the detected language but KEEP the locked gender. Prefer a
   * profile matching (language + lockedGender); only if none exists fall back
   * to any profile for that language. This stops a female agent flipping to a
   * male voice (the reported bug) when the caller speaks another language.
   */
  switchProfileByLang(detectedLang) {
    if (!detectedLang) return
    const sameGender = this.profiles.find(p => p.whisperCode === detectedLang && p.gender === this.lockedGender)
    const anyLang    = this.profiles.find(p => p.whisperCode === detectedLang)
    const match = sameGender || anyLang
    if (match && match.id !== this.currentProfile.id) {
      LOG(`lang switch: ${this.currentProfile.id} → ${match.id} (whisper=${detectedLang}, gender=${this.lockedGender})`)
      this.currentProfile = match
      this.prewarmFiller().catch(() => {})  // warm fillers for the new language
    }
  }

  onRtp(msg) {
    if (msg.length < 12) return
    const payload = msg.subarray(12)
    let sum = 0
    for (let i = 0; i < payload.length; i++) { const s = ulawByteToPcm(payload[i]); sum += s * s }
    const rms = Math.sqrt(sum / Math.max(1, payload.length))

    // ── While the AI is talking OR thinking: HALF-DUPLEX guard ──
    // The phone bridge has no echo cancellation, so the AI's own voice (and the
    // filler) loops back as "input". While speaking/fetching/processing, only a
    // LOUDER, SUSTAINED voice counts as a real barge-in; anything else is
    // ignored so the AI never cuts itself off on echo/noise.
    if (this.speaking || this._pendingTts > 0 || this.busy) {
      if (rms > BARGE_RMS) {
        this.bargeMs += 20
        if (this.bargeMs >= BARGE_MIN_MS) {
          this.playQueue.length = 0
          this.speaking = false
          this.cancelResponse = true
          this._pendingTts = 0
          this._sayChain = Promise.resolve()  // abandon in-flight chain items
          // Start capturing the caller's interrupting utterance from here.
          this.bargeMs = 0
          this.inSpeech = true
          this.silenceMs = 0
          this.speechMs = BARGE_MIN_MS
          this.utter = [Buffer.from(payload)]
        }
      } else {
        this.bargeMs = 0  // must be continuous to count as barge-in
      }
      return  // don't let echo leak into the normal capture path
    }
    this.bargeMs = 0

    // ── AI silent: normal capture VAD ──
    const voiced = rms > VAD_RMS
    if (voiced) {
      this.inSpeech = true
      this.silenceMs = 0
      this.speechMs += 20
      this.utter.push(Buffer.from(payload))
      if (this.speechMs >= MAX_UTTER_MS) this.endTurn()
    } else if (this.inSpeech) {
      this.silenceMs += 20
      this.utter.push(Buffer.from(payload))
      if (this.silenceMs >= SILENCE_MS) this.endTurn()
    }
  }

  async endTurn() {
    if (!this.inSpeech || this.busy) return
    const ms = this.speechMs
    const audio = Buffer.concat(this.utter)
    this.inSpeech = false; this.speechMs = 0; this.silenceMs = 0; this.utter = []
    if (ms < MIN_SPEECH_MS) return
    this.busy = true; this.cancelResponse = false
    // Occasional, varied acknowledgement while STT+LLM run. STT is fast now
    // (Groq ~0.4s) so fire RARELY (~30% of longer turns) and never the same
    // phrase twice — avoids the repetitive "Anladım… Anladım…" feel.
    if (ms >= 1200 && Math.random() < 0.3) this.playFiller()
    try {
      const { text, language } = await transcribe(audio)
      LOG('STT:', JSON.stringify(text), 'lang:', language)
      if (!text || this.closed) { this.busy = false; return }
      // Switch voice to match caller's language (gender preserved)
      this.switchProfileByLang(language)
      this.history.push({ role: 'user', content: text })
      // Stream the reply: TTS+play each sentence as soon as it's ready so the
      // caller hears the first words seconds earlier. shouldStop aborts on
      // hang-up or barge-in (caller starts talking over the AI).
      const stop = () => this.closed || this.cancelResponse
      // Speak each sentence but NEVER read an [[ACTION ...]] directive aloud —
      // strip from the first "[[" onward (directives are emitted last).
      const speakClean = (sentence) => {
        const spoken = sentence.includes('[[') ? sentence.slice(0, sentence.indexOf('[[')).trim() : sentence
        if (spoken) this.say(spoken)
      }
      const reply = await llmStream(this.history, speakClean, stop)
      LOG('LLM:', JSON.stringify(reply))
      if (this.closed) { this.busy = false; return }
      if (reply) {
        // Store the clean (spoken) reply in history; execute any action directive.
        const clean = reply.replace(/\[\[ACTION[\s\S]*?\]\]/g, '').trim()
        this.history.push({ role: 'assistant', content: clean || reply })
        this.runActions(reply)
      } else if (!this.cancelResponse) {
        await this.say('Anlayamadım, tekrar eder misiniz?')
      }
    } catch (e) {
      LOG('turn error:', e.message)
      try { await this.say('Bir sorun oluştu, lütfen tekrar söyler misiniz?') } catch {}
    }
    this.busy = false
  }

  /** Parse [[ACTION {json}]] directives from the raw reply and dispatch them. */
  runActions(rawReply) {
    if (!this.onAction) return
    const re = /\[\[ACTION\s*(\{[\s\S]*?\})\s*\]\]/g
    let m
    while ((m = re.exec(rawReply)) !== null) {
      let action
      try { action = JSON.parse(m[1]) } catch { LOG('bad action json:', m[1]); continue }
      LOG('ACTION:', JSON.stringify(action))
      try {
        this.onAction({
          ...action,
          hotelId: this.hotelId,
          callId: this.callId,
          caller: this.caller,
          transcript: (this.history || []).filter(t => t.role !== 'system'),
        })
      } catch (e) { LOG('action dispatch err', e.message) }
    }
  }

  // Non-blocking: kicks off TTS fetch immediately (parallel with previous sentences
  // still playing), then chains the queue-push so sentences stay in order.
  // This eliminates the inter-sentence silence gap caused by sequential fetching.
  say(text) {
    if (this.closed || !text) return
    const { lang, voice } = this.currentProfile
    this._pendingTts++
    // Start the network fetch RIGHT NOW — before the previous sentence finishes playing.
    const fetchP = ttsUlaw(text, lang, voice).catch(e => { LOG('tts err', e.message); return null })
    // Queue audio only after previous say() has finished queuing (order preserved).
    this._sayChain = this._sayChain.then(async () => {
      const ulaw = await fetchP
      this._pendingTts--
      if (!ulaw || this.closed || this.cancelResponse) return
      this._enqueue(ulaw)
      this.speaking = true
    })
  }

  /**
   * Queue a µ-law buffer as 20ms frames. The final <160-byte remainder is
   * PADDED with µ-law silence instead of being dropped — dropping it clipped
   * a few ms off the end of every TTS chunk, causing the audible clicks/
   * dropouts between sentences.
   */
  _enqueue(ulaw) {
    let i = 0
    for (; i + FRAME_BYTES <= ulaw.length; i += FRAME_BYTES) this.playQueue.push(ulaw.subarray(i, i + FRAME_BYTES))
    if (i < ulaw.length) {
      const last = Buffer.alloc(FRAME_BYTES, 0xff)  // 0xFF = µ-law silence
      ulaw.copy(last, 0, i)
      this.playQueue.push(last)
    }
  }

  // Drift-correcting pacer: Node timers fire late under load, which left audible
  // gaps between 20ms frames. Each tick sends as many frames as real elapsed
  // time requires (catch-up), so timer jitter no longer becomes audio jitter.
  tick() {
    if (this.closed) return
    const now = Date.now()
    if (!this._nextTs) this._nextTs = now
    let budget = 0
    while (this._nextTs <= now && budget < 12) {
      this._sendFrame()
      this._nextTs += 20
      budget++
    }
    // If we fell badly behind (e.g. long GC pause), resync to avoid a burst storm.
    if (now - this._nextTs > 200) this._nextTs = now
  }

  _sendFrame() {
    let frame = this.playQueue.shift()
    // Only stop speaking when queue is empty AND no TTS fetch is still in flight.
    if (!frame) { if (this.speaking && this._pendingTts === 0) this.speaking = false; frame = SILENCE_FRAME }
    const pkt = Buffer.alloc(12 + frame.length)
    pkt[0] = 0x80; pkt[1] = 0x00
    pkt.writeUInt16BE(this.seq & 0xffff, 2); this.seq = (this.seq + 1) & 0xffff
    pkt.writeUInt32BE(this.ts >>> 0, 4); this.ts = (this.ts + FRAME_BYTES) >>> 0
    pkt.writeUInt32BE(this.ssrc >>> 0, 8)
    frame.copy(pkt, 12)
    this.sock.send(pkt, this.remotePort, this.remoteIp, (e) => { if (e) {} })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pacer)
    try { this.sock.close() } catch {}
    LOG('call closed')
    // Report the call for lead capture (name/phone → CallRecord). Fire-and-forget.
    if (this.onEnd && !this._reported) {
      this._reported = true
      try {
        this.onEnd({
          hotelId: this.hotelId,
          callId: this.callId,
          caller: this.caller,
          startedAt: this.startedAt,
          endedAt: Date.now(),
          transcript: (this.history || []).filter(m => m.role !== 'system'),
        })
      } catch (e) { LOG('onEnd err', e.message) }
    }
  }
}

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff)

module.exports = { AiCall, AI_EXT, AI_RTP_PORT, PUBLIC_IP }
