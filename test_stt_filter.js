// Whisper invents text on silence, and it invents the SAME things every time.
// On a live call it produced "Altyazı M.K." — subtitle credits from its
// training data — and the agent spent the rest of the call addressing the guest
// as "Sayın M.K.".  `node test_stt_filter.js`
const providers = require('./providers')

// Not exported (it is an internal guard), so reach it through the module.
const isArtefact = providers.isHallucinatedTranscript || require('./providers').isHallucinatedTranscript

let fails = 0
const check = (ok, label) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }

console.log('— sessizlik uydurmaları ELENMELİ —')
for (const t of [
  'Altyazı M.K.',
  'Altyazı M.K',
  'Altyazı: Mehmet',
  'altyazı m.k.',
  'Abone olmayı unutmayın',
  'İzlediğiniz için teşekkür ederim',
  'Bir sonraki videoda görüşürüz',
  'Subtitles by the Amara.org community',
  'Thanks for watching!',
  '...',
  '♪',
]) check(isArtefact(t), `elendi: "${t}"`)

console.log('\n— GERÇEK konuşma ELENMEMELİ —')
for (const t of [
  'Oteliniz hakkında bilgi alabilir miyim?',
  'Teşekkürler, Deluxe Oda istiyorum.',
  'Onaylıyorum.',
  'Telefon numaram 0541 507 99 74, ismim Serdar Bayraktaroğlu.',
  'İzlediğiniz manzara çok güzelmiş, odadan deniz görünüyor mu?',
  'Evet',
]) check(!isArtefact(t), `korundu: "${t}"`)

console.log('\n— sınır durumları —')
check(!isArtefact(''), 'boş metin artefakt sayılmıyor (ayrı ele alınır)')
check(!isArtefact('Altyazılarda bahsettiğiniz kampanya hâlâ geçerli mi acaba diye sormak istiyordum'),
  'uzun cümle, kalıpla başlasa da konuşma sayılıyor')

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
