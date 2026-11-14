#!/usr/bin/env node
/**
 * Sabit ajan cümlelerini Google Cloud TTS (Chirp 3 HD) ile ÖNCEDEN üretir → assets/edge/ (µ-law, 8 kHz).
 * (Klasör adı tarihsel: önceki sürümde Edge sesiyle üretiliyordu; yükleyici manifesti okur, motoru bilmez.)
 *
 * Çağrı sırasında ajanın yanıtları da AYNI sesten gelir (providers.js sırası azure,google,piper…), böylece
 * karşılama ve "Tabii efendim." ile yanıtlar arasında ses farkı olmaz. Kapsam: karşılama, FILLERS.tr, LOOKUP_FILLERS.tr
 * (kişisel veri YOK). Seviye, çalışma anındaki Google/Piper/Azure hattıyla AYNI formülle eşitlenir (tone.js rmsNormalize).
 *
 * Kullanım (anahtar ORTAM DEĞİŞKENİNDEN okunur, asla yazdırılmaz):
 *   GOOGLE_TTS_KEY=... node scripts/render-google-phrases.js --hotel "Belconti Resort" --agent Emre --voice tr-TR-Chirp3-HD-Puck
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { pcm16ToUlaw, ulawByteToPcm } = require('../audio')
const { int16ToFloat, floatToInt16, rmsNormalize } = require('../tone')
const { FILLERS, LOOKUP_FILLERS } = require('../ai-agent')
const { piperOkunus } = require('../providers')

const arg = (ad, varsayilan) => {
  const i = process.argv.indexOf(`--${ad}`)
  return i >= 0 ? process.argv[i + 1] : varsayilan
}
const KEY = process.env.GOOGLE_TTS_KEY || ''
const HOTEL = arg('hotel', process.env.AI_HOTEL_NAME || 'Belconti Resort')
const AGENT = arg('agent', 'Emre')
const PROFIL = arg('profile', 'male-tr')
const SES = arg('voice', 'tr-TR-Chirp3-HD-Puck')
const OUT = path.join(__dirname, '..', 'assets', 'edge')

const KARSILAMA = `${HOTEL} çağrı merkezine hoş geldiniz, ben ${AGENT}. Size nasıl yardımcı olabilirim?`
const CUMLELER = [KARSILAMA, ...FILLERS.tr, LOOKUP_FILLERS.tr]

async function uret(metin) {
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text: piperOkunus(metin, 'tr') },
      voice: { languageCode: 'tr-TR', name: SES },
      audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 },
    }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.audioContent) throw new Error(`google tts ${r.status}: ${String(j.error && j.error.message || '').slice(0, 120)}`)
  const ulaw = Buffer.from(j.audioContent, 'base64')
  if (ulaw.length < 1600) throw new Error('ses çok kısa')
  const pcm = Buffer.allocUnsafe(ulaw.length * 2)
  for (let i = 0; i < ulaw.length; i++) pcm.writeInt16LE(ulawByteToPcm(ulaw[i]), i * 2)
  return pcm16ToUlaw(floatToInt16(rmsNormalize(int16ToFloat(pcm), 8000)))
}

;(async () => {
  if (KEY.length < 30) { console.error('HATA: GOOGLE_TTS_KEY ortam değişkeni yok'); process.exit(1) }
  fs.mkdirSync(OUT, { recursive: true })
  const manifestYolu = path.join(OUT, 'manifest.json')
  const manifest = fs.existsSync(manifestYolu) ? JSON.parse(fs.readFileSync(manifestYolu, 'utf8')) : {}
  const yeni = {}
  for (const metin of CUMLELER) {
    const ulaw = await uret(metin)
    const ad = `${PROFIL}-${crypto.createHash('sha1').update(metin).digest('hex').slice(0, 10)}.ulaw`
    fs.writeFileSync(path.join(OUT, ad), ulaw)
    yeni[metin] = ad
    console.log(`${(ulaw.length / 8000).toFixed(1).padStart(4)} sn  ${metin}`)
  }
  manifest[PROFIL] = yeni
  fs.writeFileSync(manifestYolu, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`manifest: ${Object.keys(yeni).length} cümle, ses ${SES} → ${OUT}`)
  process.exit(0)
})().catch((e) => { console.error('HATA:', e.message); process.exit(1) })
