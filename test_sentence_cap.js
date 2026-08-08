// The 2-sentence limit is a hard product requirement on a phone line, and three
// different models ignored it no matter where the rule sat in the prompt — so
// it is enforced in code. This covers that guarantee: cap what is SPOKEN, but
// never swallow the hand-off question.  `node test_sentence_cap.js`
const { makeSentenceCap } = require('./ai-agent')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

/** Feed sentences through a cap and report what a caller would hear. */
function run(sentences, limit = 3) {
  const cap = makeSentenceCap(limit)
  const spoken = sentences.filter(s => cap.take(s))
  const rescued = cap.rescue()
  if (rescued) spoken.push(rescued)
  return { spoken, held: cap.held, rescued }
}

// Under the cap: everything is spoken, nothing held.
let r = run(['Bir.', 'İki.'])
check(r.spoken.length === 2 && r.held.length === 0, 'sınır altında hepsi konuşuluyor', r.spoken.join(' | '))

// Over the cap with a trailing question: tail cut, question survives.
r = run(['Bir.', 'İki.', 'Üç.', 'Dört.', 'Yardımcı olabilir miyim?'])
check(r.spoken.length === 4, 'sınır üstü kesiliyor', `${r.spoken.length} cümle`)
check(r.spoken[r.spoken.length - 1].endsWith('?'), 'kapanış sorusu kurtarılıyor', r.spoken.join(' | '))
check(!r.spoken.includes('Dört.'), 'kesilen düz cümle konuşulmuyor')

// Over the cap with NO question: nothing is rescued.
r = run(['Bir.', 'İki.', 'Üç.', 'Dört.', 'Beş.'])
check(r.spoken.length === 3 && r.rescued === null, 'soru yoksa sadece sınır kadar konuşuluyor', r.spoken.join(' | '))

// The LAST question wins when several were cut.
r = run(['Bir.', 'İki.', 'Üç.', 'İlk soru?', 'Araya cümle.', 'Son soru?'])
check(r.rescued === 'Son soru?', 'birden fazla soru varsa sonuncusu alınıyor', String(r.rescued))

// A tight cap still lets the caller answer something.
r = run(['Tek cümle.', 'Devam.', 'Peki hangi tarihler?'], 1)
check(r.spoken.length === 2 && r.spoken[1].endsWith('?'),
  'sınır 1 olsa bile soru geçiyor', r.spoken.join(' | '))

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
