// Replays real conversations through the LIVE model with the production system
// prompt, and asserts on what comes back.  `node test_conversation.js`
//
// Written after a live test call in which the agent:
//   - read the prompt's own phrase book verbatim,
//   - invented "15 bin 500 TL" for a room the contract does not price,
//   - claimed "bu tarihlerde müsaitliğimiz var" without ever running the tool.
//
// A phone call is an expensive way to find that out. This exercises the same
// turns offline: same prompt, same model, same price context.
//
// Needs GROQ_API_KEY (run it inside the gateway container, which has one).
const { AiCall, buildPriceBlock, buildHotelBlock } = require('./ai-agent')
const { chatStream } = require('./providers')

// The live Belconti call-center contract, as /api/cc/route serves it.
const PRICE_CONTEXT = {
  today: new Date().toISOString().slice(0, 10),
  currency: 'TRY',
  roomTypes: ['Deluxe Oda', 'Balayı Odası', 'Aile Odası', 'Villa', 'King Suite'],
  concepts: ['Herşey Dahil'],
  prices: [
    { roomType: 'Deluxe Oda', concept: 'Herşey Dahil', from: 17020, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
    { roomType: 'Balayı Odası', concept: 'Herşey Dahil', from: 18810, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
    { roomType: 'Aile Odası', concept: 'Herşey Dahil', from: 25900, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
    { roomType: 'Villa', concept: 'Herşey Dahil', from: 40578, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31', converted: true },
    { roomType: 'King Suite', concept: 'Herşey Dahil', from: 42750, currency: 'TRY', validFrom: '2026-08-08', validTo: '2026-10-31' },
  ],
}
const HOTEL_INFO = {
  name: 'Belconti Resort', city: 'Antalya', country: 'Türkiye', stars: 5,
  concept: 'Herşey Dahil', amenities: ['Özel plaj', 'Aquapark', 'Spa', 'Çocuk kulübü'], kb: [],
}

// Room names that do NOT exist in the contract. If one is spoken, the agent
// invented a product.
const FAKE_ROOMS = [/standart\s*oda/i, /comfort\s*club/i, /suit\b(?!\s*e)/i]
// Any price the contract does not contain is fiction. Spoken Turkish numbers
// ("15 bin 500") are normalised before checking.
const REAL_PRICES = PRICE_CONTEXT.prices.map(p => p.from)

function spokenNumbers(text) {
  const out = []
  // "15 bin 500" / "on beş bin" style and plain digits.
  const re = /(\d[\d.,]*)\s*(bin)?/gi
  let m
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(n)) continue
    if (m[2]) n *= 1000
    if (n >= 1000) out.push(Math.round(n))
  }
  return out
}

async function runTurns(systemPrompt, turns) {
  const history = [{ role: 'system', content: systemPrompt }]
  const replies = []
  for (const userText of turns) {
    history.push({ role: 'user', content: userText })
    let full = ''
    const reply = await chatStream(history, (s) => { full += (full ? ' ' : '') + s }, () => false)
    const text = reply || full
    history.push({ role: 'assistant', content: text.replace(/\[\[ACTION[\s\S]*?\]\]/g, '').trim() })
    replies.push(text)
  }
  return replies
}

;(async () => {
  // The exact production prompt, assembled from the real block builders.
  const systemPrompt = AiCall.prototype.buildSystemPrompt.call({
    hotelName: HOTEL_INFO.name,
    agentName: 'Ayşe',
    _priceBlock: buildPriceBlock(PRICE_CONTEXT),
    _hotelBlock: buildHotelBlock(HOTEL_INFO),
    intent: 'RESERVATION_NEW',
    _fewShot: null,
  })

  // The exact turns from the failed live call.
  const TURNS = [
    'Otelinizle ilgili bilgi alabilir miyim?',
    'Oda fiyatlarınızla ilgili bilgi alabilir miyim? Mesela 8-12 Ağustos arası.',
    'İki yetişkin, çocuk yok.',
  ]

  console.log('system prompt:', systemPrompt.length, 'chars\n')
  const replies = await runTurns(systemPrompt, TURNS)

  let fails = 0
  const check = (ok, label, detail) => {
    if (!ok) fails++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  }

  replies.forEach((r, i) => {
    console.log(`\n--- tur ${i + 1}: "${TURNS[i]}"`)
    console.log(`    ${r.replace(/\n/g, '\n    ')}`)
  })
  console.log('')

  const all = replies.join('\n')
  const spoken = all.replace(/\[\[ACTION[\s\S]*?\]\]/g, '')

  // 1) The tool must fire once dates + pax are known.
  check(/\[\[ACTION\s*\{[^}]*check_availability/.test(all),
    'müsaitlik sorgusu çalıştırıldı')

  // 2) No invented prices.
  const nums = spokenNumbers(spoken).filter(n => n >= 5000 && n <= 500000)
  const invented = nums.filter(n => !REAL_PRICES.some(p => Math.abs(p - n) <= 1))
  check(invented.length === 0, 'uydurma fiyat yok',
    invented.length ? `uydurulan: ${invented.join(', ')} (gerçek: ${REAL_PRICES.join(', ')})` : '')

  // 3) No invented room products.
  const fakeHit = FAKE_ROOMS.filter(re => re.test(spoken)).map(re => re.source)
  check(fakeHit.length === 0, 'kontratta olmayan oda tipi anlatılmadı',
    fakeHit.length ? `geçen: ${fakeHit.join(', ')}` : '')

  // 4) No availability claim before the tool result exists.
  check(!/müsaitliğimiz var|yerimiz var|hemen ayırtabilir|boş odamız var/i.test(spoken),
    'sorgu sonucu olmadan "müsaitiz" denmedi')

  // 5) Voice length discipline.
  const longest = Math.max(...replies.map(r =>
    r.replace(/\[\[ACTION[\s\S]*?\]\]/g, '').split(/[.!?…]+/).filter(s => s.trim()).length))
  check(longest <= 3, 'yanıtlar kısa tutuldu', `en uzun ${longest} cümle`)

  // 6) The phrase book is gone from the prompt itself.
  check(!/\[Fiyat sunma\]|\[Müsaitlik\]|\[Oda tipleri\]/.test(systemPrompt),
    'ezber kalıp listesi prompt\'ta yok')

  console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
  process.exit(fails ? 1 : 0)
})().catch(e => { console.error('HATA:', e.message); process.exit(2) })
