// Nokta ayraçlı yüksek sayılar, ondalık tutarlar, yüzde, noktalı tarih/saat ve PMS fiyat satırı biçimleri.  `node test_speech_pms.js`
// Her durum, 14 Kas 2026'da gerçek Google sesi + Whisper geri yazımıyla (13/13) doğrulanan çıktılardır.
const { sanitizeForSpeech } = require('./speech')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
const says = (input, lang, mustContain, mustNotContain = []) => {
  const out = sanitizeForSpeech(input, lang)
  const miss = [].concat(mustContain).filter((w) => !out.includes(w))
  const bad = mustNotContain.filter((w) => out.includes(w))
  check(!miss.length && !bad.length, JSON.stringify(input), `→ ${JSON.stringify(out)}${miss.length ? ` | eksik: ${miss}` : ''}${bad.length ? ` | olmamalı: ${bad}` : ''}`)
}

// nokta = binlik ayracı
says('Gecelik 4.250 TL.', 'tr', 'dört bin iki yüz elli lira', ['4.250'])
says('Toplam 12.750 TL tutuyor.', 'tr', 'on iki bin yedi yüz elli lira')
says('Fiyat 1.250.000 TL.', 'tr', 'bir milyon iki yüz elli bin lira')
says('Depozito 100.000 TL.', 'tr', 'yüz bin lira')
// ondalık virgül + nokta binlik: önceden "bir milyon iki yüz otuz dört bin…" okunuyordu
says('Toplam 12.345,67 TL.', 'tr', 'on iki bin üç yüz kırk beş lira altmış yedi kuruş', ['milyon'])
says('Bakiye 1.250,50 TL.', 'tr', 'bin iki yüz elli lira elli kuruş')
says('Tutar 12.50 TL.', 'tr', 'on iki lira elli kuruş')
says('Tutar 45,05 TL.', 'tr', 'kırk beş lira beş kuruş')
says('Tutar 100,00 TL.', 'tr', ['yüz lira'], ['kuruş'])
// para birimi: "Euro" → "Euroo" olmamalı
says('Kişi başı 1.050 Euro.', 'tr', 'bin elli Euro.', ['Euroo'])
says("Fiyat 4250 EUR'dan başlıyor.", 'tr', 'dört bin iki yüz elli Eurodan', ['EUR'])
says('Aylık 1.250 € ödeme.', 'tr', 'bin iki yüz elli Euro')
says('Toplam 2.500 $ ücret.', 'tr', 'iki bin beş yüz Dolar')
// yüzde
says('%12,5 indirim var.', 'tr', 'yüzde on iki virgül beş', ['%'])
says('15% indirim.', 'tr', 'yüzde on beş', ['%'])
says('Rate is 15% off.', 'en', '15 percent', ['%'])
// tarih: noktalı biçim (yıl bugünkü değilse söylenir)
says('Giriş 12.11.2031.', 'tr', ['12 Kasım', 'iki bin otuz bir'], ['12.11'])
says('Giriş 12/11/2031.', 'tr', ['12 Kasım', 'iki bin otuz bir'])
says('Giriş 2031-07-01, çıkış 2031-07-08.', 'tr', ['1 Temmuz', '8 Temmuz'])
// noktalı saat: yalnız "saat" ön eki ya da "X ile Y arasında" ile
says('Randevu saat 14.30 de.', 'tr', 'saat on dört otuz', ['14.30'])
says('Kahvaltı 07.30 ile 10.30 arasında.', 'tr', 'yedi otuz ile on otuz arasında', ['07.30'])
says('Kahvaltı 07.30 - 10.30 arasında.', 'tr', 'yedi otuz ile on otuz arasında')
says('Puan 4.5 üzerinden.', 'tr', '4.5') // ondalık puan saat sayılmaz, olduğu gibi kalır
// PMS fiyat satırı biçimi (buildPriceBlock): "<oda>/<konsept>: <fiyat> <PB>'dan (<başlangıç>→<bitiş>)"
says("Deluxe oda UAI konseptinde 4250 EUR'dan başlıyor, 2031-07-01 ile 2031-09-15 arasında geçerli.", 'tr',
  ['ultra her şey dahil', 'dört bin iki yüz elli Eurodan', '1 Temmuz', '15 Eylül'], ['2031-07-01', 'UAI'])
says("Standart oda AI konseptinde 3150.5 TL'dan başlıyor.", 'tr', 'üç bin yüz elli lira elli kuruş')
// değişmemesi gerekenler
says('Oda numaranız 1204.', 'tr', 'bin iki yüz dört')
says('Telefon 0232 123 45 67.', 'tr', 'sıfır iki üç iki bir iki üç dört beş altı yedi')
says('Check-in saat 14:00.', 'tr', 'saat on dört')
// başka diller: motorun kendi okuması korunur (ondalık bozulmaz)
says('The total is 1,250 USD.', 'en', 'The total is 1,250 dollars')
says('Der Preis beträgt 1.250 Euro.', 'de', '1.250 Euro', ['Euroo'])


// Türkçe ek uyumu: "TL'den" → "liradan" (lira arka ünlüyle biter)
says("Gecelik 14.720 TL'den başlıyor.", 'tr', 'on dört bin yedi yüz yirmi liradan', ['liraden'])
says("Gecelik 14720 TRY'dan başlıyor.", 'tr', 'liradan')
says("Bu 3.000 TL'de kalır, 3.000 TL'ye çıkar.", 'tr', ['lirada', 'liraya'])
says("1.250 EUR'ya denk gelir.", 'tr', 'Euroya')
says("2.000 TL'lik indirim.", 'tr', 'liralık')
says("Villa için yaklaşık 38852 TRY'dan başlıyor.", 'tr', 'otuz sekiz bin sekiz yüz elli iki liradan')
// Telefon numaraları hane hane (önceden "+doksan bin dört yüz kırk dört 50 95")
says('Telefon: +90 444 50 95', 'tr', 'artı dokuz sıfır dört dört dört beş sıfır dokuz beş', ['bin'])
says('Bizi 444 50 95 numarasından arayın.', 'tr', 'dört dört dört beş sıfır dokuz beş', ['yüz'])
says('Santral +90 232 123 45 67 numarasıdır.', 'tr', 'artı dokuz sıfır iki üç iki bir iki üç dört beş altı yedi', ['bin'])
says('Call +90 444 50 95 for help.', 'en', 'plus nine zero four four four five zero nine five', ['thousand'])
// büyük sayılar bozulmasın
says('98.000 m² alana kuruludur.', 'tr', 'doksan sekiz bin metrekare')

console.log(fails ? `\n${fails} başarısız` : '\nhepsi geçti')
process.exit(fails ? 1 : 0)
