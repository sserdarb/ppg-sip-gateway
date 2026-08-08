// The persona must switch as a WHOLE — voice, language and NAME together.
//   node test_persona.js
//
// Origin: the agent name was resolved once at call setup and never again, so an
// English-speaking caller got an English voice from an agent still introducing
// itself as the Turkish name. An operator-chosen name must still win.
const { AiCall, BUILTIN_PROFILES } = require('./ai-agent')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** A call object with just enough state to exercise the persona switch. */
function agent({ pinned } = {}) {
  const a = Object.create(AiCall.prototype)
  a.profiles = BUILTIN_PROFILES
  a.currentProfile = BUILTIN_PROFILES.find(p => p.id === 'female-tr')
  a.lockedGender = 'female'
  a._agentNamePinned = !!pinned
  a.agentName = pinned || 'Elif'
  a.hotelName = 'Belconti Resort'
  a._priceBlock = ''
  a._hotelBlock = ''
  a.intent = null
  a._fewShot = null
  a.history = [{ role: 'system', content: 'x' }]
  a.prewarmFiller = async () => {}
  return a
}

// 1) Every language has BOTH genders, and no name is reused across languages.
const byLang = {}
for (const p of BUILTIN_PROFILES) (byLang[p.whisperCode] ||= []).push(p)
for (const [lang, ps] of Object.entries(byLang)) {
  const genders = new Set(ps.map(p => p.gender))
  check(genders.has('female') && genders.has('male'), `${lang}: kadın+erkek persona var`,
    [...genders].join('/'))
}
const names = BUILTIN_PROFILES.map(p => p.agentName)
check(new Set(names).size === names.length, 'her personanın kendi ismi var',
  names.length !== new Set(names).size ? 'tekrar eden isim var' : `${names.length} isim`)

// 2) The dropdown label must never leak into speech.
check(BUILTIN_PROFILES.every(p => p.agentName && !/[()]/.test(p.agentName)),
  'seslendirilecek isimler etiket içermiyor')

// 3) The name follows the language.
for (const [lang, expected] of [['en', 'Emily'], ['de', 'Lena'], ['ru', 'Анна'], ['el', 'Eleni'], ['fr', 'Camille']]) {
  const a = agent()
  a.switchProfileByLang(lang)
  check(a.agentName === expected && a.currentProfile.whisperCode === lang,
    `${lang} algılanınca isim ${expected} oluyor`, `isim=${a.agentName} profil=${a.currentProfile.id}`)
}

// 4) Gender stays locked while the name changes.
const g = agent()
g.switchProfileByLang('de')
check(g.currentProfile.gender === 'female', 'dil değişince cinsiyet korunuyor', g.currentProfile.id)

// 5) An operator-chosen name is NOT overwritten.
const pinned = agent({ pinned: 'Zeynep' })
pinned.switchProfileByLang('en')
check(pinned.agentName === 'Zeynep', 'operatörün seçtiği isim korunuyor', pinned.agentName)
check(pinned.currentProfile.whisperCode === 'en', 'ses yine de dile geçiyor', pinned.currentProfile.id)

// 6) The rebuilt system prompt carries the new name.
const p = agent()
p.switchProfileByLang('de')
check(p.history[0].content.includes('Lena') && !p.history[0].content.includes('Elif'),
  'sistem prompt\'u yeni isimle yeniden kuruldu')

console.log(fails === 0 ? `\nTÜM KONTROLLER GEÇTİ` : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
