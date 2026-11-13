// Azure TTS sağlayıcısı — AĞ OLMADAN (fetch taklit edilir).  `node test_azure_tts.js`
//   - anahtar yokken sağlayıcı kapalı, Piper'a düşer
//   - SSML: doğru ses (erkek/kadın), XML kaçışı, okunuş sözlüğü, µ-law 8 kHz istek başlığı
//   - HTTP hatası → sıradaki sağlayıcıya düşer (çağrı sessiz kalmaz)
//   - dönen ses konuşma seviyesine eşitlenir
process.env.AZURE_SPEECH_KEY = 'test-anahtar'
process.env.AZURE_SPEECH_REGION = 'westeurope'
process.env.EDGE_PHRASES = 'off'
process.env.PIPER_BIN = '/yok/piper' // Piper kapalı → Azure'un hatasında "tüm sağlayıcılar başarısız" görülebilsin
const assert = require('assert')
const { pcmToUlaw } = require('./audio')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

// 1 sn'lik, genliği ÇOK düşük bir sinüs → seviye eşitleme yükseltmeli
const sinus = (genlik) => {
  const b = Buffer.alloc(8000)
  for (let i = 0; i < 8000; i++) b[i] = pcmToUlaw(Math.round(Math.sin(i / 8000 * 2 * Math.PI * 200) * genlik * 32767))
  return b
}
const rmsOf = (ulaw) => {
  const { ulawByteToPcm } = require('./audio')
  let e = 0
  for (const u of ulaw) { const v = ulawByteToPcm(u) / 32768; e += v * v }
  return Math.sqrt(e / ulaw.length)
}

let istekler = []
let yanit = () => ({ ok: true, status: 200, arrayBuffer: async () => sinus(0.02) })
global.fetch = async (url, opts) => { istekler.push({ url, opts }); return yanit() }

const { synthesize, providerStatus } = require('./providers')

;(async () => {
  const erkek = { id: 'male-tr', lang: 'tr-TR', voice: 'x', gender: 'male' }
  const kadin = { id: 'female-tr', lang: 'tr-TR', voice: 'x', gender: 'female' }

  const ses = await synthesize('Belconti Resort <özel> & "tırnak"', erkek)
  const i = istekler[0]
  check(i && i.url === 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1', 'bölge adresi', i && i.url)
  check(i.opts.headers['X-Microsoft-OutputFormat'] === 'raw-8khz-8bit-mono-mulaw', 'çıktı biçimi µ-law 8 kHz')
  check(i.opts.headers['Ocp-Apim-Subscription-Key'] === 'test-anahtar', 'anahtar başlığı')
  check(i.opts.body.includes('tr-TR-AhmetNeural'), 'erkek profil → Ahmet')
  check(i.opts.body.includes('Belkonti Rizort'), 'okunuş sözlüğü uygulandı', i.opts.body.slice(0, 200))
  check(i.opts.body.includes('&lt;özel&gt; &amp; &quot;tırnak&quot;'), 'XML kaçışı')
  check(!i.opts.body.includes('<özel>'), 'ham < > SSML\'e sızmadı')
  check(rmsOf(ses) > 0.08, 'düşük genlikli ses konuşma seviyesine yükseltildi', rmsOf(ses).toFixed(3))

  await synthesize('Merhaba', kadin)
  check(istekler[1].opts.body.includes('tr-TR-EmelNeural'), 'kadın profil → Emel')

  yanit = () => ({ ok: false, status: 401, arrayBuffer: async () => Buffer.alloc(0) })
  let hata = null
  try { await synthesize('Merhaba', erkek) } catch (e) { hata = e }
  check(hata && /all TTS providers failed/.test(hata.message) && /401/.test(hata.message), 'HTTP hatası → zincir başarısızlığı bildirir (çağıran Piper vb. kullanır)', hata && hata.message)

  const durum = providerStatus()
  check(durum.tts.order[0] === 'azure', 'varsayılan sıra azure ile başlar', durum.tts.order.join(','))
  check(durum.tts.active.includes('azure'), 'anahtar varken azure etkin')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('HATA', e.stack || e.message); process.exit(1) })
