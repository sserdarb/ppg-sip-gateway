// What the caller actually hears.  `node test_speech.js`
//
// From a live call: the agent said "YILDIZ YILDIZ" (markdown ** read aloud) and
// spoke prices digit by digit. Asking the model to spell numbers had already
// been tried and produced nonsense ("iki beş bin doksan yüz" for 25.900), so
// the conversion lives in code and is pinned here.
const { sanitizeForSpeech, stripMarkup, speakNumbers, speakDatesAndTimes, numberToTurkish } = require('./speech')

let fails = 0
const eq = (got, want, label) => {
  const ok = got === want
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`        beklenen: ${want}\n        gelen   : ${got}`)
}
const has = (got, needle, label, want = true) => {
  const ok = got.includes(needle) === want
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — "${got}"`}`)
}

console.log('— Türkçe sayı —')
eq(numberToTurkish(0), 'sıfır', '0')
eq(numberToTurkish(7), 'yedi', '7')
eq(numberToTurkish(100), 'yüz', '100 → "yüz", "bir yüz" DEĞİL')
eq(numberToTurkish(1000), 'bin', '1000 → "bin", "bir bin" DEĞİL')
eq(numberToTurkish(1500), 'bin beş yüz', '1500')
eq(numberToTurkish(8999), 'sekiz bin dokuz yüz doksan dokuz', '8999')
eq(numberToTurkish(25900), 'yirmi beş bin dokuz yüz', '25900 (canlıda bozulan sayı)')
eq(numberToTurkish(42750), 'kırk iki bin yedi yüz elli', '42750')
eq(numberToTurkish(1320), 'bin üç yüz yirmi', '1320')
eq(numberToTurkish(2000000), 'iki milyon', '2 milyon')

console.log('\n— markdown temizliği —')
eq(stripMarkup('Aile odası **25.900 TL**\'dir.'), "Aile odası 25.900 TL'dir.", 'kalın işaretleri kalkıyor')
eq(stripMarkup('- Deluxe Oda\n- Aile Odası'), 'Deluxe Oda\nAile Odası', 'madde imleri kalkıyor')
eq(stripMarkup('## Başlık'), 'Başlık', 'başlık işareti kalkıyor')
eq(stripMarkup('`kod` ve _italik_'), 'kod ve italik', 'kod/italik işaretleri kalkıyor')
has(stripMarkup('Harika! 🎉 Bekleriz'), '🎉', 'emoji kalkıyor', false)

console.log('\n— rakamların seslendirilmesi —')
has(speakNumbers('Aile odası 25.900 TL.'), 'yirmi beş bin dokuz yüz TL', 'fiyat kelimeye çevriliyor')
has(speakNumbers('Villa 1.320 €'), 'bin üç yüz yirmi Euro', 'euro sembolü okunabilir hale geliyor')
has(speakNumbers('Toplam 17998 TL'), 'on yedi bin dokuz yüz doksan sekiz TL', 'ayraçsız fiyat')

console.log('\n— tarih ve saat konuşma dilinde —')
const y = new Date().getFullYear()
eq(speakDatesAndTimes(`${y}-08-20 girişli`), '20 Ağustos girişli', 'bu yılın tarihi: yıl söylenmiyor')
has(speakDatesAndTimes(`${y + 1}-01-05 girişli`), '5 Ocak', 'gelecek yılın tarihi')
has(speakDatesAndTimes(`${y + 1}-01-05 girişli`), numberToTurkish(y + 1), 'farklı yıl SÖYLENİYOR')
eq(speakDatesAndTimes('Giriş 14:00'), 'Giriş saat on dört', 'tam saat')
eq(speakDatesAndTimes('Çıkış 12:30'), 'Çıkış saat on iki otuz', 'buçuklu saat')

console.log('\n— dokunulmaması gerekenler —')
has(speakNumbers('Numaranız 05321112233'), '05321112233', 'telefon numarası kelimeye çevrilmiyor')
has(speakNumbers('Rezervasyon kodu 8471023'), '8471023', 'rezervasyon kodu kelimeye çevrilmiyor')

console.log('\n— uçtan uca —')
const out = sanitizeForSpeech(`**Aile Odası** 25.900 TL'dir. 🎉 ${y}-08-20 girişle, 14:00'te uygundur.`)
has(out, 'yıldız', 'çıktıda yıldız yok', false)
has(out, '*', 'çıktıda * karakteri yok', false)
has(out, 'yirmi beş bin dokuz yüz TL', 'fiyat sözlü')
has(out, '20 Ağustos', 'tarih sözlü')
has(out, 'saat on dört', 'saat sözlü')
has(out, '-', 'makine biçimi kalmadı', false)
console.log(`        → "${out}"`)

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
