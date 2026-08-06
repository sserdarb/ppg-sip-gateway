// Regression tests for the intent-router regex layer.  `node test_intent_router.js`
//
// The layer must be CONSERVATIVE: fire only on unambiguous phrasing and fall
// through to the LLM otherwise. A wrong confident answer is far worse than a
// miss, because a confident rule hit short-circuits the model entirely.
//
// Origin: "gece" matched inside "gecen sefer" and routed a complaint to
// RESERVATION_NEW. Turkish letters are not \w in JS, so \b cannot be used —
// see the boundary handling in intent-router.js.
const { ruleClassify } = require('./intent-router')

const cases = [
  // [utterance, expected intent or null (= fall through to the LLM)]

  // The regression case. Keyword-level these are genuinely ambiguous (Turkish
  // word order moves the complaint verb around), so null is CORRECT here —
  // misrouting them to RESERVATION_NEW was the bug, not the miss.
  ['gecen sefer yasadigimiz sorunu konusmak istiyorum', null],
  ['geçen sefer yaşadığımız sorunu konuşmak istiyorum', null],

  // Escalation must win instantly — never wait on a network round-trip.
  ['bir sorun yaşadık odamızda', 'COMPLAINT_URGENT'],
  ['hizmetinizden memnun kalmadık', 'COMPLAINT_URGENT'],
  ['insana baglayin lutfen', 'COMPLAINT_URGENT'],
  ['müdürünüzle görüşmek istiyorum', 'COMPLAINT_URGENT'],

  // Suffixed forms must still match (left boundary, not full word).
  ['üç gece için fiyat alabilir miyim', 'RESERVATION_NEW'],
  ['gecelik ne kadar', 'RESERVATION_NEW'],
  ['ağustosta müsaitliğiniz var mı', 'RESERVATION_NEW'],
  ['fiyatlarınızı öğrenebilir miyim', 'RESERVATION_NEW'],

  ['rezervasyonumu iptal etmek istiyorum', 'RESERVATION_EXISTING'],

  ['evcil hayvan kabul ediyor musunuz', 'HOTEL_INFO'],
  ['giriş saatiniz kaçta', 'HOTEL_INFO'],
  ['spa merkeziniz var mı', 'HOTEL_INFO'],
  // Rule order puts reservation ahead of info, so a price phrase wins even in
  // a location question. Intended: the caller is still a booking lead.
  ['havalimanına ne kadar uzaksınız', 'RESERVATION_NEW'],

  // Small talk must NOT be claimed by the regex layer.
  ['alo merhaba', null],
  ['adım Mehmet', null],
  ['tamam anladım teşekkürler', null],
]

let fails = 0
for (const [text, expected] of cases) {
  const got = ruleClassify(text)
  const intent = got ? got.intent : null
  const ok = intent === expected
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${text}" → ${intent} (expected ${expected})`)
}
console.log(fails === 0 ? `\nall ${cases.length} router cases pass` : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
