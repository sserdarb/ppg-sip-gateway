// Akış (jeton jeton) gelen LLM yanıtı cümlelere bölünürken rakam arasındaki nokta (binlik ayracı) BÖLÜNMEMELİ.  `node test_stream_split.js`
// Canlı hata: "117.760 lira" → akış tamponu bir an "…117." ile bitince cümle bölünüyor, "117." tek başına konuşulup
// sıra sayısı okunuyordu ("yüz on yedi-inci … yedi yüz altmış lira").
process.env.EDGE_PHRASES = 'off'
const { emitSentences } = require('./providers')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

// Akışı simüle et: metni verilen parçalara böl, her parçadan sonra emitSentences çağır, sonda kalanı konuş (streamOnce'ın yaptığı gibi).
async function akis(metin, parcalar) {
  const cikan = []
  let pending = ''
  let i = 0
  for (const n of parcalar) {
    pending += metin.slice(i, i + n); i += n
    pending = await emitSentences(pending, async (s) => cikan.push(s), null)
  }
  pending += metin.slice(i)
  pending = await emitSentences(pending, async (s) => cikan.push(s), null)
  if (pending.trim()) cikan.push(pending.trim())
  return cikan
}

const METINLER = [
  ['Toplam 117.760 lira tutuyor. Başka bir isteğiniz var mı?', ['Toplam 117.760 lira tutuyor.', 'Başka bir isteğiniz var mı?']],
  ['Gecelik 39.253 TL, 3 gece için toplam 117.760 TL. Rezervasyon yapalım mı?', ['Gecelik 39.253 TL, 3 gece için toplam 117.760 TL.', 'Rezervasyon yapalım mı?']],
  ['Depozito 1.250.000 TL. Tamam mı?', ['Depozito 1.250.000 TL.', 'Tamam mı?']],
  ['Villa 2.500,50 TL. Kesin fiyat için tarih verin.', ['Villa 2.500,50 TL.', 'Kesin fiyat için tarih verin.']],
  ['Odanız 1204. Keyifli konaklamalar.', ['Odanız 1204.', 'Keyifli konaklamalar.']],
]

;(async () => {
  for (const [metin, beklenen] of METINLER) {
    // 1) karakter karakter, 2) 2'şer, 3) 3'er, 4) sabit rastgele boyutlar: HER bölünme aynı cümleleri vermeli
    const rng = (() => { let x = 12345; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff })()
    const dizgeler = [
      Array(metin.length).fill(1),
      Array(Math.ceil(metin.length / 2)).fill(2),
      Array(Math.ceil(metin.length / 3)).fill(3),
      Array.from({ length: metin.length }, () => 1 + Math.floor(rng() * 5)),
    ]
    for (const [k, d] of dizgeler.entries()) {
      const sonuc = await akis(metin, d)
      check(JSON.stringify(sonuc) === JSON.stringify(beklenen), `${JSON.stringify(metin.slice(0, 40))}… bölünme #${k + 1}`, JSON.stringify(sonuc))
    }
  }
  // gerçek cümle sonu rakamla bitiyorsa da (akış bitince) kaybolmaz
  const son = await akis('Toplam 3 gece 5.', [4, 4, 4])
  check(son.length === 1 && son[0] === 'Toplam 3 gece 5.', 'cümle sonundaki "5." akış bitince konuşulur', JSON.stringify(son))
  // tek parça: önceki davranış korunur
  const bir = await akis('Evet efendim. Hemen bakıyorum.', [100])
  check(JSON.stringify(bir) === JSON.stringify(['Evet efendim.', 'Hemen bakıyorum.']), 'rakamsız metinde davranış aynı', JSON.stringify(bir))
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.log('HATA', e.stack || e.message); process.exit(1) })
