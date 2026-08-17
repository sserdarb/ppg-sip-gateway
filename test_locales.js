// The speech rules must follow the VOICE, not the hotel.
//   node test_locales.js
//
// A German caller must hear "Halbpension" and "bis", not "yarım pansiyon" and
// "ile" — and "25.900" is a price in German but a decimal in English, so the
// same digits need different treatment per language.
const { sanitizeForSpeech } = require('./speech')
const { LOCALES } = require('./locales')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const says = (lang, input, expected, mustNot = []) => {
  const out = sanitizeForSpeech(input, lang)
  const ok = [].concat(expected).every(w => out.includes(w)) && !mustNot.some(w => out.includes(w))
  check(ok, `[${lang}] "${input.slice(0, 34)}"`, `"${out}"`)
}

console.log('— pansiyon kodu her dilde ÜRÜN adı —')
says('tr', 'HB seçeneği', 'yarım pansiyon', ['HB'])
says('en', 'HB option', 'half board', ['HB'])
says('de', 'HB Angebot', 'Halbpension', ['HB'])
says('ru', 'HB вариант', 'полупансион', ['HB'])
says('fr', 'option HB', 'demi-pension', ['HB'])
says('sv', 'HB alternativ', 'halvpension', ['HB'])
says('el', 'επιλογή HB', 'ημιδιατροφή', ['HB'])
says('ar', 'خيار HB', 'نصف إقامة', ['HB'])

console.log('\n— UAI uzun kod önce eşleşmeli —')
for (const [lang, word] of [['tr', 'ultra her şey dahil'], ['en', 'ultra all inclusive'], ['de', 'Ultra All Inclusive'], ['ru', 'ультра всё включено']]) {
  says(lang, 'UAI', word, ['UAI'])
}

console.log('\n— tarih aralığı kendi bağlacıyla —')
says('tr', '20-25 Eylül', '20 ile 25', ['20-25'])
says('en', '20-25 September', '20 to 25', ['20-25'])
says('de', '20-25 September', '20 bis 25', ['20-25'])
says('ru', '20-25 сентября', '20 по 25', ['20-25'])
says('fr', '20-25 septembre', '20 au 25', ['20-25'])

console.log('\n— sayı: Türkçe yazıya, diğerleri kendi ayıracına —')
says('tr', '25.900 TL', ['yirmi beş bin dokuz yüz', 'lira'], ['25.900'])
// English must NOT keep a dot — the engine would read it as a decimal.
says('en', '25.900 TL', ['25,900', 'Turkish lira'], ['25.900'])
says('de', '25.900 EUR', ['25.900', 'Euro'])
says('ru', '25.900 EUR', ['25 900', 'евро'])

console.log('\n— tarih biçimi yerel —')
says('tr', '2026-09-20 tarihinde', '20 Eylül', ['2026-09-20'])
says('en', 'on 2026-09-20', 'September 20', ['2026-09-20'])
says('de', 'am 2026-09-20', '20. September', ['2026-09-20'])
says('ru', '2026-09-20', '20 сентября', ['2026-09-20'])

console.log('\n— dilden bağımsız korumalar her dilde çalışmalı —')
for (const lang of Object.keys(LOCALES)) {
  const out = sanitizeForSpeech('**bold** <function=x>{"a":1}</function> SPA', lang)
  check(!/[*<>{}]|function/.test(out), `[${lang}] markdown ve kod susturuluyor`, `"${out}"`)
  check(!/SPA/.test(out), `[${lang}] SPA harf harf okunmuyor`, `"${out}"`)
}

console.log('\n— bilinmeyen dil Türkçeye düşer (birincil pazar) —')
says('xx', 'HB seçeneği', 'yarım pansiyon')

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
