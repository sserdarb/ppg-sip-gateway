// Elif ASLA erkek sesle konuşmaz; Google payı/erişimi biterse Emre devralır.  `node test_persona_gender_guard.js`
process.env.AI_PERSONA_RANDOM = 'on'
process.env.GOOGLE_TTS_KEY = 'test-anahtar'
process.env.GOOGLE_TTS_DAILY_CHARS = '400'
process.env.PIPER_BIN = process.execPath // sağlayıcı "etkin" sayılsın (kadın için reddedilmeli, erkek için denenmeli)
process.env.EDGE_PHRASES = 'off'
delete process.env.AZURE_SPEECH_KEY
const { pcmToUlaw } = require('./audio')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

const ses = Buffer.alloc(8000)
for (let i = 0; i < 8000; i++) ses[i] = pcmToUlaw(Math.round(Math.sin(i / 8000 * 2 * Math.PI * 200) * 0.2 * 32767))
let googleBasarili = true
global.fetch = async () => googleBasarili
  ? { ok: true, status: 200, json: async () => ({ audioContent: ses.toString('base64') }) }
  : { ok: false, status: 403, json: async () => ({ error: { message: 'billing' } }) }

const { AiCall, BUILTIN_PROFILES, applyVoiceOverride } = require('./ai-agent')
const { synthesize } = require('./providers')
const profiles = applyVoiceOverride(BUILTIN_PROFILES)

function elifCagrisi() {
  const a = Object.create(AiCall.prototype)
  a.profiles = profiles
  a.currentProfile = profiles.find((p) => p.id === 'female-tr')
  a.lockedGender = 'female'
  a._agentNamePinned = false
  a.agentName = 'Elif'
  a.hotelName = 'Belconti Resort'
  a._priceBlock = ''
  a._hotelBlock = ''
  a.intent = null
  a._fewShot = null
  a._greeting = 'Belconti Resort çağrı merkezine hoş geldiniz, ben Elif. Size nasıl yardımcı olabilirim?'
  a._greetingSaid = false
  a.history = [{ role: 'system', content: 'x' }]
  a.systemPrompt = a.buildSystemPrompt()
  a.history[0].content = a.systemPrompt
  a.prewarmFiller = async () => {}
  return a
}

;(async () => {
  // 1) Google payı varken Elif Elif kalır
  const a1 = elifCagrisi()
  const v1 = a1._voiceFor('Tabii efendim, hemen bakıyorum.')
  check(v1.id === 'female-tr' && a1.agentName === 'Elif', 'Google payı varken Elif Elif kalır')

  // 2) pay biter → Emre devralır: ses, ad, kilitli cinsiyet, sistem istemi, (henüz söylenmemiş) karşılama
  const E = profiles.find((p) => p.id === 'female-tr')
  const harca = 'Bu cümle günlük karakter payını harcamak için yazıldı ve yeterince uzun. '
  for (let i = 0; i < 5; i++) await synthesize(harca, E) // ~5 × 72 = 360 karakter
  const a2 = elifCagrisi()
  const v2 = a2._voiceFor('Merhaba, size nasıl yardımcı olabilirim?')
  check(v2.id === 'male-tr' && v2.gender === 'male', 'günlük pay bitince çağrı Emre (male-tr) ile sürer', v2.id)
  check(a2.agentName === 'Emre' && a2.lockedGender === 'male', 'ad Emre, cinsiyet kilidi erkek')
  check(/Emre/.test(a2.systemPrompt) && a2.history[0].content === a2.systemPrompt, 'sistem istemi Emre adıyla yenilendi')
  check(a2._greeting.includes('ben Emre') && !a2._greeting.includes('Elif'), 'söylenmemiş karşılamadaki ad da değişti', a2._greeting)
  check(a2._voiceFor('Başka bir cümle.').id === 'male-tr', 'Emre\'ye geçen çağrı geri dönmez')

  // 3) karşılama zaten söylendiyse metne dokunulmaz
  const a3 = elifCagrisi()
  a3._greetingSaid = true
  a3._voiceFor('x')
  check(a3.agentName === 'Emre' && a3._greeting.includes('Elif'), 'söylenmiş karşılama değiştirilmez (ad yalnız sonraki konuşmada Emre)')

  // 4) Elif Piper'ın erkek sesine ASLA düşmez; erkek persona düşebilir
  googleBasarili = false
  let hataKadin = null
  try { await synthesize('Merhaba.', E) } catch (e) { hataKadin = e }
  check(hataKadin && /no Piper voice for female/.test(hataKadin.message), 'Google çökerse Elif için Piper reddedilir (erkek sese düşmez)', hataKadin && hataKadin.message.slice(0, 110))
  let hataErkek = null
  try { await synthesize('Merhaba.', profiles.find((p) => p.id === 'male-tr')) } catch (e) { hataErkek = e }
  check(hataErkek && !/for female/.test(hataErkek.message), 'erkek persona için Piper hâlâ yedek olarak denenir', hataErkek && hataErkek.message.slice(0, 110))

  // 5) aynı dilde erkek persona yoksa geçiş yapılmaz
  const a5 = elifCagrisi()
  a5.profiles = profiles.filter((p) => p.id !== 'male-tr')
  check(a5._switchGender('male', 'deneme') === false && a5.currentProfile.id === 'female-tr', 'aynı dilde erkek persona yoksa geçiş yok')

  process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('HATA', e.stack || e.message); process.exit(1) })
