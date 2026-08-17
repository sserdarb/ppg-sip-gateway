// Hotel abbreviations must be SPOKEN, not spelled.  `node test_abbrev.js`
//
// Live complaint: the engine read "SPA" as "S-P-A". Spelling is right for a
// PNR and wrong for spa — and the board codes are worse than mispronounced:
// "UAI" as three letters means nothing to a guest, while "ultra her şey dahil"
// is the product being sold.
const { sanitizeForSpeech, expandAbbreviations } = require('./speech')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const says = (input, expected, mustNot = []) => {
  const out = sanitizeForSpeech(input)
  const ok = out.includes(expected) && !mustNot.some(w => out.includes(w))
  check(ok, `"${input.slice(0, 44)}"`, `"${out}"`)
}

console.log('— pansiyon kodları (ürün adı, harf değil) —')
says('UAI konseptimiz', 'ultra her şey dahil', ['UAI'])
says('UALL konsept', 'ultra her şey dahil', ['UALL'])
says('AI konseptiyle', 'her şey dahil', ['AI'])
says('HB seçeneği', 'yarım pansiyon', ['HB'])
says('FB seçeneği', 'tam pansiyon', ['FB'])
says('BB fiyatı', 'oda kahvaltı', ['BB'])
says('RO satışı', 'sadece oda', ['RO'])
// UAI must not be eaten by the AI rule.
check(!/(^|\s)her şey dahil/.test(expandAbbreviations('UAI').replace('ultra her şey dahil', '')),
  'UAI kuralı AI kuralına yem olmuyor', expandAbbreviations('UAI'))

console.log('\n— tesis ve jargon —')
says('SPA merkezimiz', 'spa', ['SPA'])
says('Wi-Fi şifresi', 'vay fay', ['Wi-Fi', 'Wi Fi'])
says('WIFI var mı', 'vay fay', ['WIFI'])
says('odada TV var', 'televizyon', ['TV'])
says('WC nerede', 'tuvalet', ['WC'])
says('2 PAX için', 'kişi', ['PAX'])
says('C/In saati', 'giriş', ['C/In'])
says('check-in saati', 'çekin', ['check-in', 'check in'])
says('à la carte restoran', 'alakart')
says('stop sale durumu', 'satışa kapalı')

console.log('\n— birimler —')
says('45 m² oda', 'metrekare', ['m²'])
says('havaalanına 40 km', 'kilometre')
says('290 metrelik plaj', 'metre')

console.log('\n— para birimi —')
says('25.900 TL', 'lira', ['TL'])
says('1.320 EUR', 'Euro')

console.log('\n— yanlış eşleşme olmamalı —')
// A real word that merely contains the letters must survive.
const keep = (input, word) => {
  const out = sanitizeForSpeech(input)
  check(out.includes(word), `"${input}" bozulmuyor`, `"${out}"`)
}
keep('Aile Odası müsait', 'Aile Odası')
keep('bodrum katında', 'bodrum')
keep('havuz başı', 'havuz')
keep('robot süpürge', 'robot')

console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
process.exit(fails ? 1 : 0)
