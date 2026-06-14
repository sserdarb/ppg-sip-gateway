// ai-agent.js — Multilingual AI concierge for the AI extension (default 7000).
// caller audio (PCMU/RTP) → energy VAD → Whisper STT (self-hosted, auto language detect)
// → NVIDIA LLM (responds in caller's language) → Google Cloud TTS (matching voice profile)
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
const TTS_KEY     = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ''
const NVIDIA_KEY  = process.env.NVIDIA_API_KEY || ''
const NVIDIA_URL  = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
const LLM_MODEL   = process.env.AI_LLM_MODEL || 'meta/llama-3.3-70b-instruct'
const HOTEL       = process.env.AI_HOTEL_NAME || 'otelimiz'
const LOG = (...a) => console.log('[ai]', ...a)

// ── built-in voice profiles (overridable via constructor) ────────────────────
const BUILTIN_PROFILES = [
  { id: 'female-tr', name: 'Ayşe',   lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-E' },
  { id: 'male-tr',   name: 'Ahmet',  lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-B' },
  { id: 'female-en', name: 'Sophie', lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-F' },
  { id: 'male-en',   name: 'James',  lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-D' },
  { id: 'female-de', name: 'Greta',  lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-F' },
  { id: 'female-ru', name: 'Наташа', lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-A' },
  { id: 'female-ar', name: 'نور',    lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-A' },
]

// VAD / timing
const FRAME_BYTES   = 160
const SILENCE_MS    = 800
const MIN_SPEECH_MS = 300
const MAX_UTTER_MS  = 15000
const VAD_RMS       = parseInt(process.env.AI_VAD_RMS || '500', 10)

// ── G.711 µ-law codec ────────────────────────────────────────────────────────
const ULAW_DECODE = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  let t = ((u & 0x0f) << 3) + 0x84
  t <<= (u & 0x70) >> 4
  ULAW_DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}
function ulawByteToPcm(b) { return ULAW_DECODE[b & 0xff] }

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
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) })
  const j = await r.json().catch(() => ({}))
  return { text: (j.text || '').trim(), language: (j.language || '').toLowerCase() }
}

async function llmReply(history) {
  const r = await fetch(`${NVIDIA_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NVIDIA_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages: history, temperature: 0.4, max_tokens: 160 }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => ({}))
  return (j.choices?.[0]?.message?.content || '').trim()
}

/** Google Cloud TTS → MULAW 8kHz raw bytes using given lang + voice name */
async function ttsUlaw(text, lang, voiceName) {
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
   */
  constructor({ remoteIp, remotePort, onBye, greetingOverride, agentName, voiceProfiles, defaultVoiceProfileId } = {}) {
    this.remoteIp   = remoteIp
    this.remotePort = remotePort
    this.onBye      = onBye

    // Resolve voice profiles
    this.profiles = (Array.isArray(voiceProfiles) && voiceProfiles.length)
      ? voiceProfiles : BUILTIN_PROFILES
    const defId = defaultVoiceProfileId || 'female-tr'
    this.currentProfile = this.profiles.find(p => p.id === defId) || this.profiles[0]

    // Agent identity
    this.agentName = agentName || this.currentProfile.name || 'Asistan'
    const hotel = HOTEL === 'otelimiz' ? 'otelimiz' : HOTEL

    // Greeting
    const defaultGreeting = `${hotel} çağrı merkezine hoş geldiniz, ben ${this.agentName}. Size nasıl yardımcı olabilirim?`
    this._greeting = greetingOverride || defaultGreeting

    // System prompt: handles multiple languages automatically
    this.systemPrompt = process.env.AI_SYSTEM_PROMPT ||
      `Sen ${hotel} çağrı merkezinde telefonda görüşen ${this.agentName} adlı bir sesli asistansın.` +
      ` TEMEL KURAL: Arayan kişi hangi dilde konuşuyorsa SEN DE O DİLDE yanıt ver — dil değiştirme, sadece eşleştir.` +
      ` Türkçe, İngilizce, Almanca, Rusça ve Arapça konuşabilirsin.` +
      ` Yanıtlarını KISA tut — telefonda olduğun için 1-2 cümleyi geçme.` +
      ` Rezervasyon, oda, olanak, konum, fiyat ve ulaşım sorularında yardımcı ol.` +
      ` Kesin bilmediğin konuları uydurma; bir yetkiliye bağlamayı öner. Sıcak ve doğal konuş.`

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

    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (m) => this.onRtp(m))
    this.sock.on('error', (e) => LOG('rtp sock err', e.message))
    this.sock.bind(AI_RTP_PORT, '0.0.0.0', () =>
      LOG(`RTP bound :${AI_RTP_PORT} peer=${remoteIp}:${remotePort} profile=${this.currentProfile.id}`))

    this.pacer = setInterval(() => this.tick(), 20)
    setTimeout(() => this.say(this._greeting), 700)
  }

  /** Pick the voice profile whose whisperCode matches the detected language */
  switchProfileByLang(detectedLang) {
    if (!detectedLang) return
    const match = this.profiles.find(p => p.whisperCode === detectedLang)
    if (match && match.id !== this.currentProfile.id) {
      LOG(`lang switch: ${this.currentProfile.id} → ${match.id} (whisper=${detectedLang})`)
      this.currentProfile = match
    }
  }

  onRtp(msg) {
    if (msg.length < 12) return
    const payload = msg.subarray(12)
    let sum = 0
    for (let i = 0; i < payload.length; i++) { const s = ulawByteToPcm(payload[i]); sum += s * s }
    const rms = Math.sqrt(sum / Math.max(1, payload.length))
    const voiced = rms > VAD_RMS

    if (voiced) {
      if (this.speaking) { this.playQueue.length = 0; this.speaking = false; this.cancelResponse = true }
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
    try {
      const { text, language } = await whisperTranscribe(audio)
      LOG('STT:', JSON.stringify(text), 'lang:', language)
      if (!text || this.closed) { this.busy = false; return }
      // Switch voice to match caller's language
      this.switchProfileByLang(language)
      this.history.push({ role: 'user', content: text })
      const reply = await llmReply(this.history)
      LOG('LLM:', JSON.stringify(reply))
      if (this.closed || this.cancelResponse) { this.busy = false; return }
      this.history.push({ role: 'assistant', content: reply || 'Anlayamadım, tekrar eder misiniz?' })
      await this.say(reply || 'Anlayamadım, tekrar eder misiniz?')
    } catch (e) {
      LOG('turn error:', e.message)
      try { await this.say('Bir sorun oluştu, lütfen tekrar söyler misiniz?') } catch {}
    }
    this.busy = false
  }

  async say(text) {
    if (this.closed || !text) return
    let ulaw
    const { lang, voice } = this.currentProfile
    try { ulaw = await ttsUlaw(text, lang, voice) } catch (e) { LOG('tts err', e.message); return }
    if (this.closed || this.cancelResponse) return
    for (let i = 0; i + FRAME_BYTES <= ulaw.length; i += FRAME_BYTES) this.playQueue.push(ulaw.subarray(i, i + FRAME_BYTES))
    this.speaking = true
  }

  tick() {
    if (this.closed) return
    let frame = this.playQueue.shift()
    if (!frame) { if (this.speaking && this.playQueue.length === 0) this.speaking = false; frame = SILENCE_FRAME }
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
  }
}

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff)

module.exports = { AiCall, AI_EXT, AI_RTP_PORT, PUBLIC_IP }
