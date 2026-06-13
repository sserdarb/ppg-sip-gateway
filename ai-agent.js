// ai-agent.js — Türkçe sesli AI concierge for the AI extension (default 7000).
// No OpenAI: caller audio (PCMU/RTP) → energy VAD → Whisper STT (self-hosted)
// → NVIDIA LLM → Google Cloud TTS (tr-TR WaveNet, MULAW) → PCMU/RTP back.
//
// Media path: the WebRTC softphone leg is bridged to plain PCMU by rtpengine
// (the gateway already transcodes WebRTC→PCMU on the "PBX side"). Here the AI
// IS that PBX side: rtpengine relays the caller's PCMU to our AI RTP port and
// our PCMU back to the caller. So we only ever see plain G.711 µ-law @ 8kHz.

const dgram = require('dgram')
const crypto = require('crypto')
const os = require('os')

// Our own RTP address that rtpengine sends caller audio to. The gateway runs
// in a Docker container on the coolify network (10.0.1.x); rtpengine runs on
// the host and can reach that container IP directly — so we advertise the
// container's own non-internal IPv4 (NOT the public IP, NOT a published port).
function detectIp() {
  const ifs = os.networkInterfaces()
  for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address
  return '127.0.0.1'
}

// ── config ──────────────────────────────────────────────────────────────────
const AI_EXT       = process.env.AI_EXTENSION || '7000'
const AI_RTP_PORT  = parseInt(process.env.AI_RTP_PORT || '5071', 10)
const PUBLIC_IP    = process.env.AI_RTP_IP || detectIp()
const WHISPER_URL  = (process.env.WHISPER_URL || 'http://161.97.132.250:9009').replace(/\/$/, '')
const WHISPER_LANG = process.env.WHISPER_LANG || 'tr'
const TTS_KEY      = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ''
const TTS_VOICE    = process.env.AI_TTS_VOICE || 'tr-TR-Wavenet-E'
const TTS_LANG     = process.env.AI_TTS_LANG || 'tr-TR'
const NVIDIA_KEY   = process.env.NVIDIA_API_KEY || ''
const NVIDIA_URL   = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
const LLM_MODEL    = process.env.AI_LLM_MODEL || 'meta/llama-3.3-70b-instruct'
const HOTEL        = process.env.AI_HOTEL_NAME || 'otelimiz'
const GREETING     = process.env.AI_GREETING || `${HOTEL === 'otelimiz' ? 'İyi günler, otelimize hoş geldiniz' : HOTEL + ' resepsiyonu'}. Size nasıl yardımcı olabilirim?`
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  `Sen ${HOTEL} resepsiyonunda telefonda görüşen, sıcak ve profesyonel bir Türk asistanısın. ` +
  `Misafirlere KISA, net ve doğal Türkçe yanıt ver — telefonda olduğun için 1-2 cümleyi geçme. ` +
  `Rezervasyon, müsaitlik, oda tipleri, olanaklar, konum, ulaşım ve genel sorularda yardımcı ol. ` +
  `Bilmediğin kesin bilgiyi UYDURMA; gerekirse bir yetkiliye aktarmayı öner. Nazik ve akıcı konuş.`
const LOG = (...a) => console.log('[ai]', ...a)

// VAD / timing
const FRAME_BYTES   = 160              // 20ms µ-law @ 8kHz
const SILENCE_MS    = 800              // end-of-turn after this much trailing silence
const MIN_SPEECH_MS = 300              // ignore blips shorter than this
const MAX_UTTER_MS  = 15000            // hard cap on one utterance
const VAD_RMS       = parseInt(process.env.AI_VAD_RMS || '500', 10)  // PCM16 RMS speech threshold

// ── G.711 µ-law codec (ITU-T G.711) ─────────────────────────────────────────
const ULAW_DECODE = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  let t = ((u & 0x0f) << 3) + 0x84
  t <<= (u & 0x70) >> 4
  ULAW_DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}
function ulawByteToPcm(b) { return ULAW_DECODE[b & 0xff] }

// ── tiny WAV writer (PCM16 mono 8kHz) for Whisper ────────────────────────────
function pcm16ToWav(pcmBuf, rate = 8000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBuf.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcmBuf.length, 40)
  return Buffer.concat([h, pcmBuf])
}

// ── external AI calls ────────────────────────────────────────────────────────
async function whisperTranscribe(ulawFrames) {
  // ulawFrames: Buffer of concatenated µ-law bytes → PCM16 WAV → Whisper
  const pcm = Buffer.alloc(ulawFrames.length * 2)
  for (let i = 0; i < ulawFrames.length; i++) pcm.writeInt16LE(ulawByteToPcm(ulawFrames[i]), i * 2)
  const wav = pcm16ToWav(pcm, 8000)
  const form = new FormData()
  form.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'a.wav')
  const url = `${WHISPER_URL}/asr?encode=true&task=transcribe&language=${WHISPER_LANG}&output=json`
  const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) })
  const j = await r.json().catch(() => ({}))
  return (j.text || '').trim()
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

async function ttsUlaw(text) {
  // Google Cloud TTS → MULAW 8kHz → raw µ-law bytes
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: TTS_LANG, name: TTS_VOICE },
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
  constructor({ remoteIp, remotePort, onBye, greetingOverride } = {}) {
    this.remoteIp = remoteIp        // rtpengine AI-side addr (where we send RTP)
    this.remotePort = remotePort
    this.onBye = onBye
    this._greeting = greetingOverride || GREETING
    this.seq = (Math.random() * 0xffff) | 0
    this.ts = (Math.random() * 0xffffffff) >>> 0
    this.ssrc = (Math.random() * 0xffffffff) >>> 0
    this.playQueue = []             // µ-law frames to send to caller
    this.speaking = false           // AI currently talking (for barge-in)
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }]
    this.utter = []                 // collected µ-law during speech
    this.inSpeech = false
    this.speechMs = 0
    this.silenceMs = 0
    this.busy = false               // STT/LLM/TTS in flight
    this.closed = false

    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (m) => this.onRtp(m))
    this.sock.on('error', (e) => LOG('rtp sock err', e.message))
    this.sock.bind(AI_RTP_PORT, '0.0.0.0', () => LOG(`RTP bound :${AI_RTP_PORT} peer=${remoteIp}:${remotePort}`))

    // 20ms playout pacer
    this.pacer = setInterval(() => this.tick(), 20)
    // greet shortly after answer
    setTimeout(() => this.say(this._greeting), 700)
  }

  onRtp(msg) {
    if (msg.length < 12) return
    const payload = msg.subarray(12)   // strip RTP header (no extensions expected from rtpengine)
    // discover remote (rtpengine may use a different src port) — lock to first seen
    // (we already send to the SDP addr; receive is fine from anywhere)
    // energy VAD on this 20ms frame
    let sum = 0
    for (let i = 0; i < payload.length; i++) { const s = ulawByteToPcm(payload[i]); sum += s * s }
    const rms = Math.sqrt(sum / Math.max(1, payload.length))
    const voiced = rms > VAD_RMS

    if (voiced) {
      // barge-in: caller talks while AI speaks → cut AI off
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
      const text = await whisperTranscribe(audio)
      LOG('STT:', JSON.stringify(text))
      if (!text || this.closed) { this.busy = false; return }
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
    try { ulaw = await ttsUlaw(text) } catch (e) { LOG('tts err', e.message); return }
    if (this.closed || this.cancelResponse) return
    // chunk into 160-byte frames, queue for the pacer
    for (let i = 0; i + FRAME_BYTES <= ulaw.length; i += FRAME_BYTES) this.playQueue.push(ulaw.subarray(i, i + FRAME_BYTES))
    this.speaking = true
  }

  tick() {
    if (this.closed) return
    let frame = this.playQueue.shift()
    if (!frame) { if (this.speaking && this.playQueue.length === 0) this.speaking = false; frame = SILENCE_FRAME }
    // build RTP packet (PT 0 = PCMU)
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

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff)  // µ-law silence ≈ 0xFF

module.exports = { AiCall, AI_EXT, AI_RTP_PORT, PUBLIC_IP }
