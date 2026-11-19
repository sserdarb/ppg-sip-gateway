// Deterministic price speech from a check_availability result.
const { buildAvailabilitySpeech, spokenDate } = require('./availability-speech')
let fail = 0
const check = (c, n, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + d}`); if (!c) fail++ }

check(spokenDate('2026-11-24') === '24 Kasım', 'tarih okunuşu')
check(spokenDate('x') === '', 'geçersiz tarih boş')

const base = { dataAvailable: true, checkIn: '2026-11-24', checkOut: '2026-11-28', nights: 4, adults: 2, children: 0, currency: 'TRY', anyAvailable: true, stockDataAvailable: false,
  available: [{ roomType: 'Standart Oda', concept: 'Herşey Dahil', totalStay: 24000, fromPerNight: 6000, currency: 'TRY', converted: false },
              { roomType: 'Deluxe Oda', concept: 'Herşey Dahil', totalStay: 30000, fromPerNight: 7500, currency: 'TRY', converted: true }] }
const t = buildAvailabilitySpeech(base)
check(/24 Kasım giriş, 28 Kasım çıkış, 4 gece, 2 yetişkin/.test(t), 'tarih + gece + kişi okunur', t)
check(/Standart Oda.*toplam 24\.000 TL, gecelik 6\.000 TL/.test(t), 'toplam + gecelik fiyat', t)
check(/Deluxe Oda.*yaklaşık 30\.000 TL/.test(t), 'çevrilmiş fiyat yaklaşık', t)
check(/teyid/.test(t), 'stok bilinmiyorsa kesin söz yok', t)
check(!/yerimiz var|ayırdım/.test(t), 'rezervasyon vaadi yok', t)
check(/uygun oda göremedim/.test(buildAvailabilitySpeech({ ...base, anyAvailable: false, available: [] })), 'oda yoksa alternatif tarih')
check(/anlayamadım/.test(buildAvailabilitySpeech({ dataAvailable: false, reason: 'past-date' })), 'geçmiş tarih → tarihi tekrar iste')
check(buildAvailabilitySpeech(null) === '' && buildAvailabilitySpeech({ dataAvailable: false, reason: 'no-contract-data' }) === '', 'veri yoksa boş (transfer)')
process.exit(fail ? 1 : 0)
