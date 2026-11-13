#!/usr/bin/env node
/**
 * Sabit ajan cümlelerini Edge (Ahmet) sesiyle ÖNCEDEN üretir → assets/edge/ (µ-law, 8 kHz).
 *
 * Kapsam (yalnız bunlar dışarı gider, kişisel veri YOK): karşılama, FILLERS.tr, LOOKUP_FILLERS.tr.
 * Çağrı sırasında hiçbir metin dışarı gitmez; değişken yanıtlar yerel Piper'dadır.
 *
 * Gereksinim: ffmpeg + Edge TTS uç noktası (hub `/api/media/tts`, ör. http://127.0.0.1:20128).
 * Kullanım:
 *   node scripts/render-edge-phrases.js --hub http://127.0.0.1:20128 --hotel "Belconti Resort" --agent Emre
 * Ses seviyesi, Piper hattıyla AYNI formülle eşitlenir (tone.js rmsNormalize).
 * Okunuş: Piper sözlüğü (providers.piperOkunus) Edge metnine de uygulanır — "Belconti" → "Belkonti".
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { pcm16ToUlaw } = require('../audio')
const { int16ToFloat, floatToInt16, rmsNormalize } = require('../tone')
const { FILLERS, LOOKUP_FILLERS } = require('../ai-agent')
const { piperOkunus } = require('../providers')

const arg = (ad, varsayilan) => {
  const i = process.argv.indexOf(`--${ad}`)
  return i >= 0 ? process.argv[i + 1] : varsayilan
}
const HUB = arg('hub', 'http://127.0.0.1:20128').replace(/\/$/, '')
const HOTEL = arg('hotel', process.env.AI_HOTEL_NAME || 'Belconti Resort')
const AGENT = arg('agent', 'Emre')
const PROFIL = arg('profile', 'male-tr')
const OUT = path.join(__dirname, '..', 'assets', 'edge')

const KARSILAMA = `${HOTEL} çağrı merkezine hoş geldiniz, ben ${AGENT}. Size nasıl yardımcı olabilirim?`
const CUMLELER = [KARSILAMA, ...FILLERS.tr, LOOKUP_FILLERS.tr]

async function uret(metin) {
  const url = `${HUB}/api/media/tts?lang=tr&text=${encodeURIComponent(piperOkunus(metin, 'tr'))}`
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) })
  if (!r.ok) throw new Error(`hub ${r.status}`)
  const mp3 = Buffer.from(await r.arrayBuffer())
  const tmp = path.join(require('os').tmpdir(), `edge-${process.pid}.mp3`)
  fs.writeFileSync(tmp, mp3)
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-ar', '8000', '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 64 << 20 })
  fs.unlinkSync(tmp)
  if (pcm.length < 3200) throw new Error('ses çok kısa')
  const norm = floatToInt16(rmsNormalize(int16ToFloat(pcm), 8000))
  return pcm16ToUlaw(norm)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const manifestYolu = path.join(OUT, 'manifest.json')
  const manifest = fs.existsSync(manifestYolu) ? JSON.parse(fs.readFileSync(manifestYolu, 'utf8')) : {}
  manifest[PROFIL] = {}
  for (const metin of CUMLELER) {
    const ulaw = await uret(metin)
    const ad = `${PROFIL}-${crypto.createHash('sha1').update(metin).digest('hex').slice(0, 10)}.ulaw`
    fs.writeFileSync(path.join(OUT, ad), ulaw)
    manifest[PROFIL][metin] = ad
    console.log(`${(ulaw.length / 8000).toFixed(1).padStart(4)} sn  ${metin}`)
  }
  fs.writeFileSync(manifestYolu, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`manifest: ${Object.keys(manifest[PROFIL]).length} cümle → ${OUT}`)
  process.exit(0)
})().catch((e) => { console.error('HATA:', e.message); process.exit(1) })
