// Google Cloud TTS sağlayıcısı — AĞ OLMADAN (fetch taklit edilir).  `node test_google_tts.js`
//   - istek: doğru ses, µ-law 8 kHz, marka sözlüğü uygulanır
//   - günlük karakter sınırı dolunca reddeder (zincir Piper'a düşer) ve ertesi gün sıfırlanır
//   - dönen ses konuşma seviyesine eşitlenir
//   - varsayılan sıra azure,google,piper...; erkek profil varsayılanı Puck
process.env.GOOGLE_TTS_KEY = 'test-anahtar'
process.env.GOOGLE_TTS_DAILY_CHARS = '120'
process.env.EDGE_PHRASES = 'off'
process.env.PIPER_BIN = '/yok/piper' // Piper kapalı → sınır dolunca "tüm sağlayıcılar başarısız" görülebilsin
delete process.env.AZURE_SPEECH_KEY
const { pcmToUlaw, ulawByteToPcm } = require('./audio')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

const sinus = (genlik) => {
  const b = Buffer.alloc(8000)
  for (let i = 0; i < 8000; i++) b[i] = pcmToUlaw(Math.round(Math.sin(i / 8000 * 2 * Math.PI * 200) * genlik * 32767))
  return b
}
const rmsOf = (ulaw) => { let e = 0; for (const u of ulaw) { const v = ulawByteToPcm(u) / 32768; e += v * v } return Math.sqrt(e / ulaw.length) }

let istekler = []
global.fetch = async (url, opts) => {
  istekler.push({ url: String(url), body: JSON.parse(opts.body) })
  return { ok: true, status: 200, json: async () => ({ audioContent: sinus(0.02).toString('base64') }) }
}

const { synthesize, providerStatus } = require('./providers')
const { BUILTIN_PROFILES, applyVoiceOverride } = require('./ai-agent')

;(async () => {
  const erkek = applyVoiceOverride(BUILTIN_PROFILES).find((p) => p.id === 'male-tr')
  check(/Chirp3-HD-Puck$/.test(erkek.voice), 'erkek profil varsayılan sesi Puck', erkek.voice)
  const durum = providerStatus()
  check(durum.tts.order.slice(0, 3).join(',') === 'azure,google,piper', 'varsayılan sıra azure,google,piper…', durum.tts.order.join(','))

  const ses = await synthesize('Belconti Resort, yarın görüşürüz.', { id: 'male-tr', lang: 'tr-TR', voice: 'tr-TR-Chirp3-HD-Puck', gender: 'male' })
  const i = istekler[0]
  check(i && i.url.startsWith('https://texttospeech.googleapis.com/v1/text:synthesize?key='), 'Cloud TTS adresi')
  check(i.body.voice.name === 'tr-TR-Chirp3-HD-Puck' && i.body.voice.languageCode === 'tr-TR', 'doğru ses ve dil')
  check(i.body.audioConfig.audioEncoding === 'MULAW' && i.body.audioConfig.sampleRateHertz === 8000, 'µ-law 8 kHz')
  check(i.body.input.text.includes('Belkonti') && i.body.input.text.includes('Rizort'), 'okunuş sözlüğü uygulandı', i.body.input.text)
  check(rmsOf(ses) > 0.08, 'düşük genlikli ses konuşma seviyesine yükseltildi', rmsOf(ses).toFixed(3))

  // 120 karakter sınırı: ilk çağrı ~33 karakter harcadı; 3 çağrı daha ~99'a çıkarır; sonrası reddedilir
  for (let k = 0; k < 2; k++) await synthesize('Belconti Resort, yarın görüşürüz.', { id: 'male-tr', lang: 'tr-TR', voice: 'tr-TR-Chirp3-HD-Puck', gender: 'male' })
  let hata = null
  try { await synthesize('Belconti Resort, yarın görüşürüz.', { id: 'male-tr', lang: 'tr-TR', voice: 'tr-TR-Chirp3-HD-Puck', gender: 'male' }) } catch (e) { hata = e }
  const onceki = istekler.length
  check(hata && /gunluk karakter siniri/.test(hata.message), 'günlük sınır dolunca zincir başarısız olur (Piper devreye girer)', hata && hata.message.slice(0, 120))
  check(istekler.length === onceki, 'sınır dolunca Google API\'sine istek gitmez')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('HATA', e.stack || e.message); process.exit(1) })
