// What the caller actually HEARS.  `node test_speech.js`
//
// Every case here came off a real call:
//   - the agent said "yıldız yıldız" for **bold**
//   - prices were read digit by digit
//   - "20-25 Eylül" became "yirmi TİRE yirmi beş"
//   - "check-in saat 14:00" became "saat SAAT on dört"
//   - a dictated phone number lost its leading zero
const {
  sanitizeForSpeech, stripMarkup, numberToTurkish, digitsToTurkish, speakSeparators,
} = require('./speech')

let fails = 0
const check = (ok, label, detail) => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const says = (input, mustContain, mustNotContain = []) => {
  const out = sanitizeForSpeech(input)
  const missing = [].concat(mustContain).filter(w => !out.includes(w))
  const leaked = [].concat(mustNotContain).filter(w => out.includes(w))
  check(missing.length === 0 && leaked.length === 0,
    `"${input.slice(0, 46)}"`,
    missing.length ? `eksik: ${missing.join(', ')} → "${out}"`
      : leaked.length ? `sızan: ${leaked.join(', ')} → "${out}"` : `"${out}"`)
}

console.log('— sayılar —')
check(numberToTurkish(25900) === 'yirmi beş bin dokuz yüz', 'yirmi beş bin dokuz yüz', numberToTurkish(25900))
check(numberToTurkish(1000) === 'bin', '"bir bin" değil "bin"', numberToTurkish(1000))
check(numberToTurkish(173650) === 'yüz yetmiş üç bin altı yüz elli', '173.650', numberToTurkish(173650))
// "TL" is spoken "lira" — the engine read the two letters as "te le".
says('Deluxe Oda 173.650 TL', ['yüz yetmiş üç bin altı yüz elli', 'lira'], ['173', '.'])

console.log('\n— markdown —')
says('**Aile Odası** 264.250 TL', ['Aile Odası', 'iki yüz altmış dört bin'], ['*'])
check(stripMarkup('- madde\n## Başlık').includes('madde'), 'madde imi ve başlık temizleniyor')

console.log('\n— tarih ve saat —')
says('2026-09-20 tarihinde', ['20 Eylül'], ['2026-09-20', '-'])
says('check-in saat 14:00', ['saat on dört'], ['14:00'])
check(!/saat\s+saat/.test(sanitizeForSpeech('check-in saat 14:00')),
  '"saat saat" tekrarı yok', sanitizeForSpeech('check-in saat 14:00'))

console.log('\n— tire (canlı çağrıdaki şikâyet) —')
says('20-25 Eylül tarihleri', ['20 ile 25', 'Eylül'], ['20-25'])
// These now go through the abbreviation layer, which gives the Turkish spoken
// form rather than merely dropping the hyphen (see test_abbrev.js).
says('check-in ve check-out saatleri', ['çekin', 'çekaut'], ['check-in', 'check-out'])
says('e-posta adresiniz', ['e posta'], ['e-posta'])
says('Wi-Fi şifresi', ['vay fay'], ['Wi-Fi'])

console.log('\n— telefon numarası —')
check(digitsToTurkish('0532') === 'sıfır beş üç iki', 'rakam rakam okunuyor', digitsToTurkish('0532'))
says('0532-111-22-33 numarasından', ['sıfır beş üç iki'], ['0532', '-'])
// The leading zero is the whole point: dropping it dictates a different number.
check(sanitizeForSpeech('0532-111-22-33').startsWith('sıfır'),
  'baştaki sıfır korunuyor', sanitizeForSpeech('0532-111-22-33'))

console.log('\n— cümleye bölme (fiyatı ikiye bölüyordu) —')
{
  const { emitSentences } = require('./providers')
  const collect = async (text) => {
    const out = []
    const rest = await emitSentences(text, (s) => { out.push(s) }, () => false)
    return { out, rest }
  }
  // The live failure: "160.280" was cut at the thousands separator, and the
  // orphaned "160." was spoken as an ordinal — "yüz altmışINCI".
  collect('Aile Odası 160.280 TL. Başka sorunuz var mı?').then(({ out }) => {
    check(!out.some(s => /\d\.$/.test(s.trim())),
      'binlik ayıracından bölmüyor', JSON.stringify(out))
    check(out.some(s => s.includes('160.280')),
      'fiyat tek parça kalıyor', JSON.stringify(out))
    check(out.length === 2, 'gerçek cümle sonları hâlâ bölünüyor', `${out.length} cümle`)

    // And end to end: the whole sentence must speak as words.
    const spoken = sanitizeForSpeech(out[0] || '')
    check(spoken.includes('yüz altmış bin iki yüz seksen') && !spoken.includes('160'),
      'bölünmeyen fiyat kelimeye çevriliyor', spoken)

    console.log(fails === 0 ? '\nTÜM KONTROLLER GEÇTİ' : `\n${fails} KONTROL BAŞARISIZ`)
    process.exit(fails ? 1 : 0)
  })
}

console.log('\n— dokunulmaması gerekenler —')
says('5 yıldızlı otel', ['5 yıldızlı'])
says('ornek@otel.com adresine', ['ornek@otel.com'])
check(speakSeparators('3-4 gece').includes('3 ile 4'), 'kısa aralık da çevriliyor')
// Result is reported by the async sentence-splitting block above.
