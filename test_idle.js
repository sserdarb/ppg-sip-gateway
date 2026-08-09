// A call must never die in silence.  `node test_idle.js`
//
// Live failure: the guest was asked for their contact details, gave them, and
// nothing happened again — the line stayed open with nobody answering. Two
// causes, both covered here:
//
//   1. the guest answered while the agent was still THINKING, and the
//      half-duplex guard threw their speech away as if it were echo;
//   2. once that happened, nothing ever nudged the call back to life.
const { AiCall } = require('./ai-agent')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** A call object with just enough state to drive the watchdog. */
function call(state = {}) {
  const c = Object.create(AiCall.prototype)
  Object.assign(c, {
    closed: false, speaking: false, busy: false, inSpeech: false,
    _pendingTts: 0, _quietSince: null, _idleNudged: false, _idleHandedOff: false,
    spoken: [], actions: [],
  }, state)
  c.say = (t) => c.spoken.push(t)
  c.dispatchAction = (a) => c.actions.push(a)
  return c
}

const NUDGE = 8000
const HANDOFF = 15000

// Quiet but still within the grace period: say nothing.
let c = call({ _quietSince: Date.now() - 3000 })
c.checkIdle(Date.now())
check(c.spoken.length === 0, 'kısa sessizlikte müdahale yok')

// Quiet too long: nudge once.
c = call({ _quietSince: Date.now() - (NUDGE + 500) })
c.checkIdle(Date.now())
check(c.spoken.length === 1 && /orada mısınız/i.test(c.spoken[0]), 'uzun sessizlikte bir kez soruyor', c.spoken[0])

// ...and only once, not on every tick.
const before = c.spoken.length
for (let i = 0; i < 5; i++) c.checkIdle(Date.now())
check(c.spoken.length === before, 'her tick\'te tekrar sormuyor', `${c.spoken.length} kez konuştu`)

// Still nothing after the nudge: hand over rather than hold an empty line.
c._quietSince = Date.now() - (HANDOFF + 500)
c.checkIdle(Date.now())
check(c.actions.some(a => a.type === 'transfer'), 'cevap gelmezse insana aktarıyor',
  JSON.stringify(c.actions[0] || null))

// The watchdog must stay out of the way while the agent is mid-turn.
for (const [label, st] of [
  ['konuşurken', { speaking: true }],
  ['düşünürken', { busy: true }],
  ['misafir konuşurken', { inSpeech: true }],
  ['ses üretilirken', { _pendingTts: 1 }],
]) {
  const x = call({ _quietSince: Date.now() - 60000, ...st })
  x.checkIdle(Date.now())
  check(x.spoken.length === 0 && x.actions.length === 0, `${label} müdahale etmiyor`)
}

// The guard must suppress ONLY while audio is playing — "thinking" used to
// swallow the guest's answer whole.
const suppresses = (st) => {
  const x = call(st)
  return !!(x.speaking || x._pendingTts > 0)
}
check(suppresses({ speaking: true }), 'konuşurken giriş bastırılıyor (eko koruması)')
check(suppresses({ _pendingTts: 1 }), 'ses üretilirken bastırılıyor')
check(!suppresses({ busy: true }), 'DÜŞÜNÜRKEN misafirin sesi ARTIK yutulmuyor')

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
