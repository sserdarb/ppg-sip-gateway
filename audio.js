// audio.js — G.711 µ-law codec + WAV helpers shared by the AI agent and the
// pluggable STT/TTS providers. Extracted from ai-agent.js so providers.js can
// convert provider audio (WAV/PCM) to the 8kHz µ-law the RTP path speaks
// without duplicating the tables.

// ── G.711 µ-law decode table ────────────────────────────────────────────────
const ULAW_DECODE = new Int16Array(256)
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff
  let t = ((u & 0x0f) << 3) + 0x84
  t <<= (u & 0x70) >> 4
  ULAW_DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84)
}

function ulawByteToPcm(b) { return ULAW_DECODE[b & 0xff] }

/** G.711 µ-law encoder (inverse of ulawByteToPcm). */
function pcmToUlaw(s) {
  if (s < -32768) s = -32768
  if (s > 32767) s = 32767
  const sign = s < 0 ? 0x80 : 0
  if (sign) s = -s
  s += 0x84
  let exp = 7
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  return (~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f))) & 0xff
}

/** Linear resample a PCM16 Buffer from srcRate Hz to dstRate Hz (mono). */
function resamplePcm16(buf, srcRate, dstRate) {
  const srcN = buf.length >> 1
  const dstN = Math.floor(srcN * dstRate / srcRate)
  const out = Buffer.allocUnsafe(dstN * 2)
  const ratio = srcN / dstN
  for (let i = 0; i < dstN; i++) {
    const pos = i * ratio
    const lo = Math.min(Math.floor(pos), srcN - 1)
    const hi = Math.min(lo + 1, srcN - 1)
    const a = buf.readInt16LE(lo * 2)
    const b = buf.readInt16LE(hi * 2)
    out.writeInt16LE(Math.round(a + (b - a) * (pos - lo)), i * 2)
  }
  return out
}

/** Parse RIFF/WAV bytes → { pcm (PCM16 LE), sampleRate, channels, bitsPerSample }. */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV')
  let pos = 12, sampleRate = 0, channels = 1, bitsPerSample = 16, dataOff = 0, dataLen = 0
  while (pos < buf.length - 8) {
    const tag = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (tag === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
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

/** Minimal PCM16 mono → RIFF/WAV. */
function pcm16ToWav(pcmBuf, rate = 8000) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmBuf.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcmBuf.length, 40)
  return Buffer.concat([h, pcmBuf])
}

/** Captured µ-law RTP payload → 8kHz mono WAV (what every STT provider wants). */
function ulawToWav(ulawFrames) {
  const pcm = Buffer.alloc(ulawFrames.length * 2)
  for (let i = 0; i < ulawFrames.length; i++) pcm.writeInt16LE(ulawByteToPcm(ulawFrames[i]), i * 2)
  return pcm16ToWav(pcm, 8000)
}

/** Provider WAV bytes (any rate/channels) → 8kHz µ-law, ready for the RTP pacer. */
function wavToUlaw(wavBuf) {
  const { pcm, sampleRate, channels, bitsPerSample } = parseWav(wavBuf)
  let mono = pcm
  if (channels === 2 && bitsPerSample === 16) {
    mono = Buffer.allocUnsafe(pcm.length >> 1)
    for (let i = 0, o = 0; i < pcm.length; i += 4, o += 2)
      mono.writeInt16LE((pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) >> 1, o)
  }
  return pcm16ToUlaw(sampleRate === 8000 ? mono : resamplePcm16(mono, sampleRate, 8000))
}

/** PCM16 @8kHz → µ-law bytes. */
function pcm16ToUlaw(pcm8k) {
  const ulaw = Buffer.allocUnsafe(pcm8k.length >> 1)
  for (let i = 0; i < ulaw.length; i++) ulaw[i] = pcmToUlaw(pcm8k.readInt16LE(i * 2))
  return ulaw
}

module.exports = {
  ULAW_DECODE, ulawByteToPcm, pcmToUlaw,
  resamplePcm16, parseWav, pcm16ToWav,
  ulawToWav, wavToUlaw, pcm16ToUlaw,
}
