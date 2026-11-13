/**
 * tone.js — Piper sesini, önceden üretilmiş Edge (Ahmet) cümlelerine ton olarak yaklaştırır.
 *
 * NEDEN: ajan karma çalışır — sabit cümleler (karşılama, "Tabii efendim.") Edge Ahmet ile önceden
 * üretilir, değişken yanıtlar yerel Piper ile. İki farklı model BİRE BİR aynı olamaz; bu modül farkı
 * ölçülebilir ölçüde azaltır (2026-11-13 ölçümü, aynı cümle, telefon yolu):
 *   Edge   : f0 medyan 131 Hz · spektral merkez 292 Hz · %85 kenar 469 Hz
 *   Piper  : f0 medyan 111 Hz · spektral merkez 345 Hz · %85 kenar 562 Hz   (ham)
 *   Piper* : f0 medyan 129 Hz · spektral merkez 267 Hz · %85 kenar 438 Hz   (bu modülle)
 * Perde DEĞİŞİMİ (Edge 4,5 yarım ton, Piper 2,2) bu yolla değişmez — modelin sınırıdır.
 *
 * Dış bağımlılık yok (kapsülde ffmpeg yok). Hepsi PCM üzerinde, saf JS.
 */

// RBJ "Audio EQ Cookbook" bikuadları. Katsayılar a0'a bölünmüş döner.
function norm(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** 2. derece Butterworth alçak geçiren (Q = 1/√2). */
function lowpass(fc, fs, q = Math.SQRT1_2) {
  const w0 = 2 * Math.PI * fc / fs, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q)
  return norm((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
}

/** Alçak raf (bass) yükseltme/kısma; gainDb > 0 yükseltir. */
function lowShelf(fc, fs, gainDb, slope = 1) {
  const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * fc / fs
  const cos = Math.cos(w0), sin = Math.sin(w0)
  const alpha = sin / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2)
  const t = 2 * Math.sqrt(A) * alpha
  return norm(
    A * ((A + 1) - (A - 1) * cos + t),
    2 * A * ((A - 1) - (A + 1) * cos),
    A * ((A + 1) - (A - 1) * cos - t),
    (A + 1) + (A - 1) * cos + t,
    -2 * ((A - 1) + (A + 1) * cos),
    (A + 1) + (A - 1) * cos - t,
  )
}

/** Tek kutuplu alçak geçiren (6 dB/oktav) — ffmpeg `lowpass=p=1` karşılığı. */
function onePoleLowpass(x, fc, fs) {
  const a = 1 - Math.exp(-2 * Math.PI * fc / fs)
  const y = new Float32Array(x.length)
  let prev = 0
  for (let i = 0; i < x.length; i++) { prev += a * (x[i] - prev); y[i] = prev }
  return y
}

function biquad(x, c) {
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v
    y[i] = v
  }
  return y
}

function int16ToFloat(buf) {
  const n = buf.length >> 1, x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(i * 2) / 32768
  return x
}

function floatToInt16(x) {
  const out = Buffer.allocUnsafe(x.length * 2)
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]))
    out.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return out
}

/**
 * Konuşma ses seviyesini hedef RMS'e getirir (yalnız konuşma karelerinin RMS'i sayılır; sessizlik
 * ortalamayı bozmasın). Tepe 0,95'i aşacaksa kazanç kısılır. Edge ön-işlemesiyle AYNI formül —
 * iki ses arasında seviye sıçraması olmasın.
 */
const TARGET_RMS = 0.12 // ≈ −18 dBFS
function rmsNormalize(x, fs, target = TARGET_RMS) {
  const frame = Math.max(1, Math.round(fs * 0.02))
  const rms = []
  let maxRms = 0, peak = 0
  for (let i = 0; i + frame <= x.length; i += frame) {
    let s = 0
    for (let j = 0; j < frame; j++) { const v = x[i + j]; s += v * v; const a = Math.abs(v); if (a > peak) peak = a }
    const r = Math.sqrt(s / frame)
    rms.push(r)
    if (r > maxRms) maxRms = r
  }
  const speech = rms.filter((r) => r > maxRms * 0.1)
  if (!speech.length || peak === 0) return x
  const cur = Math.sqrt(speech.reduce((a, r) => a + r * r, 0) / speech.length)
  let gain = target / cur
  if (peak * gain > 0.95) gain = 0.95 / peak
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = x[i] * gain
  return y
}

/**
 * Piper → telefon: perde yükseltme (örnekleme hızı hilesi) + indirmeden ÖNCE anti-alias + tını eşleme.
 * @param {Buffer} pcm  Piper ham çıktısı, PCM16 LE, modelRate Hz
 * @param {number} modelRate  Piper model hızı (22050)
 * @param {number} k  perde çarpanı (1.20 ≈ +3,2 yarım ton). Piper, length_scale*k ile üretilmiş olmalı
 * @param {(buf:Buffer, src:number, dst:number)=>Buffer} resample  audio.js resamplePcm16
 * @returns {Buffer} PCM16 LE @8 kHz, seviyesi eşitlenmiş
 */
function piperToPhone(pcm, modelRate, k, resample) {
  const eff = modelRate * k                        // ham çıktı bu hızda çalınıyormuş gibi → perde k kat
  let x = int16ToFloat(pcm)
  x = biquad(x, lowpass(3300, eff))               // 8 kHz'e inmeden önce üst bandı kes (katlanma gürültüsü olmasın)
  x = biquad(x, lowpass(3300, eff))
  let p8 = resample(floatToInt16(x), eff, 8000)
  x = int16ToFloat(p8)
  x = onePoleLowpass(x, 1100, 8000)               // tiz kısma: Edge'in daha koyu tınısına yaklaşır
  x = biquad(x, lowShelf(200, 8000, 4))           // bas yükseltme: gövde
  x = rmsNormalize(x, 8000)
  return floatToInt16(x)
}

module.exports = {
  lowpass, lowShelf, onePoleLowpass, biquad,
  int16ToFloat, floatToInt16, rmsNormalize, piperToPhone, TARGET_RMS,
}
