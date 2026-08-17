// A turn that is ONLY a tool call is a real turn.  `node test_tool_turn.js`
//
// Live failure: the guest gave dates and party size, the model answered with a
// tool call and no prose, and because the text was empty the turn counted as
// "not understood" — the lookup we had just captured was discarded, the guest
// was told "anlayamadım", and two of those triggered a transfer nobody asked
// for. It happened three times in one call and no price was ever quoted.
const { AiCall } = require('./ai-agent')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Decide the branch endTurn() would take for a given model output. */
function branch({ reply, native = [] }) {
  const self = { _nativeToolCalls: native }
  const actions = AiCall.prototype.parseActions.call(self, reply || '')
  return (reply || actions.length) ? 'handled' : 'failedTurn'
}

// The exact live case: native tool call, empty text.
check(branch({ reply: '', native: [{ type: 'check_availability', checkIn: '2026-10-03', checkOut: '2026-10-07', adults: 2 }] }) === 'handled',
  'sadece araç çağıran tur işleniyor (metin yok)')

// Text + tool call — always worked, must keep working.
check(branch({ reply: 'Hemen kontrol ediyorum.', native: [{ type: 'check_availability' }] }) === 'handled',
  'metin + araç birlikte işleniyor')

// Text only.
check(branch({ reply: 'Buyurun efendim.' }) === 'handled', 'sadece metin işleniyor')

// The text-channel form with no prose around it.
check(branch({ reply: '[[ACTION {"type":"check_availability","checkIn":"2026-10-03"}]]' }) === 'handled',
  'metin kanalı tek başına işleniyor')
check(branch({ reply: '<function=check_availability>{"adults":2}</function>' }) === 'handled',
  '<function=...> tek başına işleniyor')

// Genuinely empty: nothing said, nothing called → this IS a failed turn.
check(branch({ reply: '' }) === 'failedTurn', 'gerçekten boş tur hâlâ hata sayılıyor')
check(branch({ reply: null }) === 'failedTurn', 'null yanıt hâlâ hata sayılıyor')

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
