// A tool call written in ANY format must run — and must never be spoken.
//   node test_tool_syntax.js
//
// Live call: the model wrote
//   <function=check_availability>{"checkIn":"2026-09-20",...}</function>
// which matched neither agreed channel. The lookup never ran (the guest said
// "fiyatı öğrenemedim") AND the raw tag was read out loud as code.
const { AiCall } = require('./ai-agent')
const { sanitizeForSpeech } = require('./speech')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const parse = (reply, native = []) =>
  AiCall.prototype.parseActions.call({ _nativeToolCalls: native }, reply)

console.log('— araç çağrısı ayrıştırma —')
{
  const a = parse('Kontrol ediyorum. <function=check_availability>{"checkIn":"2026-09-20","checkOut":"2026-09-25","adults":2}</function>')
  check(a.length === 1 && a[0].type === 'check_availability', '<function=...> tanınıyor', JSON.stringify(a[0] || null))
  check(a[0]?.checkIn === '2026-09-20' && a[0]?.adults === 2, 'argümanları doğru okunuyor', JSON.stringify(a[0]))
}
{
  const a = parse('Tamam. [[ACTION {"type":"transfer","department":"sales"}]]')
  check(a.length === 1 && a[0].type === 'transfer', '[[ACTION]] hâlâ çalışıyor', JSON.stringify(a[0] || null))
}
{
  const a = parse('x', [{ type: 'check_availability', checkIn: '2026-09-20' }])
  check(a.length === 1 && a[0].type === 'check_availability', 'yerli tool call çalışıyor')
}
{
  // Same action on two channels must fire once, not twice.
  const a = parse('[[ACTION {"type":"transfer","department":"sales"}]]', [{ type: 'transfer', department: 'sales' }])
  check(a.length === 1, 'iki kanaldan gelen aynı aksiyon tekrarlanmıyor', `${a.length} aksiyon`)
}

console.log('\n— hiçbiri seslendirilmemeli —')
const mustBeSilent = [
  '<function=check_availability>{"checkIn":"2026-09-20","adults":2}</function>',
  '[[ACTION {"type":"transfer","department":"sales"}]]',
  '{"type":"check_availability","adults":2}',
  '```json\n{"a":1}\n```',
  '<tool_call>bir şey</tool_call>',
]
for (const raw of mustBeSilent) {
  const out = sanitizeForSpeech(raw)
  check(!/[{}<>]|function=|ACTION/.test(out), `sessiz: ${raw.slice(0, 42)}`, `"${out}"`)
}

console.log('\n— cümlenin içine gömülüyse konuşma korunmalı —')
{
  const out = sanitizeForSpeech('Hemen kontrol ediyorum. <function=check_availability>{"adults":2}</function>')
  check(out.includes('Hemen kontrol ediyorum'), 'insan cümlesi korunuyor', `"${out}"`)
  check(!out.includes('function'), 'kod kısmı atılıyor', `"${out}"`)
}

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
