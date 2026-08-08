// Does the agent repeat itself over a LONG call?  `node test_repetition.js`
//
// The 3-turn script in test_conversation.js proves correctness, not variety.
// Repetition only shows up with length: the model settles into one opener and
// one acknowledgement and says them every turn, which is what a caller hears as
// "robotic". This drives a 10-turn conversation and measures it.
const { AiCall, buildPriceBlock, buildHotelBlock } = require('./ai-agent')
const { chatStream } = require('./providers')

const PRICE_CONTEXT = {
  today: new Date().toISOString().slice(0, 10),
  currency: 'TRY',
  roomTypes: ['Deluxe Oda', 'Balayı Odası', 'Aile Odası', 'King Suite'],
  concepts: ['Herşey Dahil'],
  prices: [
    { roomType: 'Deluxe Oda', concept: 'Herşey Dahil', from: 17020, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
    { roomType: 'Balayı Odası', concept: 'Herşey Dahil', from: 18810, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
    { roomType: 'Aile Odası', concept: 'Herşey Dahil', from: 25900, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
    { roomType: 'King Suite', concept: 'Herşey Dahil', from: 42750, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
  ],
}
const HOTEL_INFO = {
  name: 'Belconti Resort', city: 'Antalya', country: 'Türkiye', stars: 5,
  concept: 'Herşey Dahil', amenities: ['Özel plaj', 'Aquapark', 'Spa', 'Çocuk kulübü'], kb: [],
}

// A realistic call that keeps the agent talking — the shape that exposes ruts.
const TURNS = [
  'Merhaba, oteliniz hakkında bilgi almak istiyorum.',
  'Plajınız nasıl, denize sıfır mı?',
  'Çocuklar için ne var?',
  'Ağustos sonu için düşünüyoruz.',
  'İki yetişkin bir de sekiz yaşında çocuk.',
  'Aile odası ne kadar?',
  'Biraz pahalı geldi açıkçası.',
  'Peki spa dahil mi fiyata?',
  'Havaalanından transfer var mı?',
  'Tamam, teklifi nasıl alabilirim?',
]

const STOP = new Set(['ve', 'ile', 'bir', 'bu', 'da', 'de', 'için', 'the', 'a'])
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

;(async () => {
  const systemPrompt = AiCall.prototype.buildSystemPrompt.call({
    hotelName: HOTEL_INFO.name,
    agentName: 'Elif',
    _priceBlock: buildPriceBlock(PRICE_CONTEXT),
    _hotelBlock: buildHotelBlock(HOTEL_INFO),
    intent: 'RESERVATION_NEW',
    _fewShot: null,
  })

  const history = [{ role: 'system', content: systemPrompt }]
  const replies = []
  for (const t of TURNS) {
    history.push({ role: 'user', content: t })
    let acc = ''
    let text = ''
    try {
      const r = await chatStream(history, (s) => { acc += (acc ? ' ' : '') + s }, () => false)
      text = (r || acc).replace(/\[\[ACTION[\s\S]*?\]\]/g, '').trim()
    } catch (e) {
      // One slow or rate-limited turn must not discard the whole sample —
      // that is how the first runs of this harness died with nothing to show.
      console.log(`M: ${t}\n!! tur atlandı: ${e.message.slice(0, 90)}\n`)
      history.pop()
      continue
    }
    history.push({ role: 'assistant', content: text })
    replies.push(text)
    console.log(`M: ${t}\nA: ${text}\n`)
  }
  if (replies.length < 4) {
    console.log(`\nYETERSİZ ÖRNEK (${replies.length} tur) — ölçüm yapılamadı`)
    process.exit(2)
  }

  let fails = 0
  const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

  // 1) Openers: the first two words of each reply should rarely repeat.
  const openers = replies.map(r => words(r).slice(0, 2).join(' ')).filter(Boolean)
  const openerCounts = {}
  for (const o of openers) openerCounts[o] = (openerCounts[o] || 0) + 1
  const worstOpener = Object.entries(openerCounts).sort((a, b) => b[1] - a[1])[0] || ['', 0]
  check(worstOpener[1] <= 2, 'aynı açılış kalıbı tekrarlanmıyor',
    `"${worstOpener[0]}" ${worstOpener[1]}/${replies.length} turda`)

  // 1b) The CLOSING QUESTION is what a caller notices most. Extract the last
  //     question SENTENCE (splitting on "?" alone returns the whole reply, which
  //     hid a stock closer repeating across turns).
  const closers = replies.map(r => {
    const sentences = r.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean)
    const q = [...sentences].reverse().find(s => s.endsWith('?'))
    return (q || '').toLowerCase().replace(/[^\p{L}\s]/gu, '').trim()
  }).filter(Boolean)
  const closerCounts = {}
  for (const c of closers) closerCounts[c] = (closerCounts[c] || 0) + 1
  const worstCloser = Object.entries(closerCounts).sort((a, b) => b[1] - a[1])[0] || ['', 0]
  check(worstCloser[1] <= 2, 'aynı kapanış sorusu tekrarlanmıyor',
    `"${worstCloser[0].slice(0, 60)}" ${worstCloser[1]}/${closers.length} turda`)

  // 2) The stock acknowledgements the prompt explicitly bans stacking.
  const fillers = ['tabii', 'anladım', 'elbette', 'memnuniyetle', 'tabi ki', 'harika']
  const fillerHits = fillers.map(f => [f, replies.filter(r => r.toLowerCase().includes(f)).length])
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const worstFiller = fillerHits[0] || ['-', 0]
  check(worstFiller[1] <= 3, 'dolgu onayları peş peşe kullanılmıyor',
    fillerHits.length ? fillerHits.map(([f, n]) => `${f}×${n}`).join(', ') : 'hiç kullanılmadı')

  // 3) Consecutive replies should not be near-copies of each other.
  let worstOverlap = 0, worstPair = ''
  for (let i = 1; i < replies.length; i++) {
    const a = new Set(words(replies[i - 1]).filter(w => !STOP.has(w) && w.length > 3))
    const b = new Set(words(replies[i]).filter(w => !STOP.has(w) && w.length > 3))
    if (!a.size || !b.size) continue
    const inter = [...b].filter(w => a.has(w)).length
    const ratio = inter / Math.min(a.size, b.size)
    if (ratio > worstOverlap) { worstOverlap = ratio; worstPair = `tur ${i}→${i + 1}` }
  }
  check(worstOverlap < 0.6, 'ardışık yanıtlar birbirinin kopyası değil',
    `en yüksek örtüşme %${Math.round(worstOverlap * 100)} (${worstPair})`)

  // 4) Voice discipline has to survive a long call, not just the first turns.
  const longest = Math.max(...replies.map(r => r.split(/[.!?…]+/).filter(s => s.trim()).length))
  check(longest <= 3, 'uzun konuşmada da yanıtlar kısa kalıyor', `en uzun ${longest} cümle`)

  // 5) No bullet lists read aloud.
  check(!replies.some(r => /^\s*[-•*]\s/m.test(r)), 'madde imli liste okumuyor')

  console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error('HATA:', e.message); process.exit(2) })
