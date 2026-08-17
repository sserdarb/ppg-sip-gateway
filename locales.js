// locales.js — how each language the agent speaks wants to HEAR things.
//
// The speech layer began as Turkish-only because that is where the live calls
// were, but every rule in it is language-specific: "UAI" is a product name that
// must be spoken as the product, "25.900" is a price in Turkish and German and
// a decimal in English, and a date range joins with "ile", "to", "bis" or "по".
// Shipping the Turkish rules to a German caller would be its own bug.
//
// So each language gets a profile. Turkish spells numbers out because the
// engine demonstrably mangles them (it read "160." as an ordinal, "yüz
// altmışıncı"); the other locales get their thousands separator NORMALISED to
// local convention instead, which their engines read correctly — a smaller,
// safer intervention than hand-writing a number speller per language.

// ── Turkish numerals ────────────────────────────────────────────────────────
const TR_ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz']
const TR_TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan']
const TR_SCALES = [{ v: 1e9, w: 'milyar' }, { v: 1e6, w: 'milyon' }, { v: 1e3, w: 'bin' }]

function trUnderThousand(n) {
  const out = []
  const h = Math.floor(n / 100)
  if (h) out.push(h === 1 ? 'yüz' : `${TR_ONES[h]} yüz`)
  const rest = n % 100
  const t = Math.floor(rest / 10)
  if (t) out.push(TR_TENS[t])
  const o = rest % 10
  if (o) out.push(TR_ONES[o])
  return out.join(' ')
}

/** Whole number → Turkish words. 25900 → "yirmi beş bin dokuz yüz". */
function numberToTurkish(n) {
  n = Math.round(Math.abs(n))
  if (n === 0) return 'sıfır'
  const parts = []
  let left = n
  for (const { v, w } of TR_SCALES) {
    const count = Math.floor(left / v)
    if (count) {
      // "bin" alone, never "bir bin" — but "bir milyon" IS correct.
      parts.push(count === 1 && w === 'bin' ? 'bin' : `${trUnderThousand(count)} ${w}`)
      left -= count * v
    }
  }
  if (left) parts.push(trUnderThousand(left))
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// ── shared abbreviation shapes ──────────────────────────────────────────────
// Board codes are the important ones: read as letters they tell a guest
// nothing, while spoken they are the name of the product being sold.
const boardCodes = (o) => [
  [/\bU\.?A\.?L\.?L\b/gi, o.uai],
  [/\bU\.?A\.?I\b/gi, o.uai],
  [/\bA\.?L\.?L\b(?!\s*[a-zçğıöşü])/g, o.ai],
  [/\bA\.?I\b(?![-\s]*(?:destek|asistan|yapay|assistant))/g, o.ai],
  [/\bH\.?B\b/g, o.hb],
  [/\bF\.?B\b/g, o.fb],
  [/\bB\.?B\b/g, o.bb],
  [/\bR\.?O\b/g, o.ro],
  [/\bO\.?B\b/g, o.ro],
]

// Uppercase SPA is read as an initialism by every engine tested; lowercase is
// read as the word. Same trick works in each language.
const commonFacilities = [
  [/\bSPA\b/g, 'spa'],
  [/\bW\.?C\b/g, 'WC'],
  [/\bF\s*&\s*B\b/gi, 'F and B'],
]

const LOCALES = {
  tr: {
    // The engine mangles Turkish numerals, so they are spelled out in code.
    spellNumbers: numberToTurkish,
    months: ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
      'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'],
    // "20 Ağustos" — day first.
    formatDate: (d, month, year) => `${d} ${month}${year ? ` ${year}` : ''}`,
    timeWord: 'saat',
    rangeWord: 'ile',
    digits: ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'],
    currency: { tl: 'lira', '₺': 'lira', try: 'lira', '€': 'Euro', eur: 'Euro', euro: 'Euro', $: 'Dolar', usd: 'Dolar' },
    abbreviations: [
      ...boardCodes({
        uai: 'ultra her şey dahil', ai: 'her şey dahil', hb: 'yarım pansiyon',
        fb: 'tam pansiyon', bb: 'oda kahvaltı', ro: 'sadece oda',
      }),
      [/\bSPA\b/g, 'spa'],
      [/\bWi[-\s]?Fi\b/gi, 'vay fay'], [/\bWIFI\b/g, 'vay fay'],
      [/\bT\.?V\b/g, 'televizyon'], [/\bW\.?C\b/g, 'tuvalet'], [/\bA\/?C\b/g, 'klima'],
      [/\bF\s*&\s*B\b/gi, 'yiyecek içecek'], [/\bVIP\b/g, 'vip'],
      [/\bPAX\b/gi, 'kişi'],
      [/\bC\s*\/\s*In\b/gi, 'giriş'], [/\bC\s*\/\s*Out\b/gi, 'çıkış'],
      [/\bcheck[-\s]?in\b/gi, 'çekin'], [/\bcheck[-\s]?out\b/gi, 'çekaut'],
      [/\bno[-\s]?show\b/gi, 'gelmeme'], [/\bstop\s*sale\b/gi, 'satışa kapalı'],
      [/(?<![\p{L}])[aà]\s*la\s*carte(?![\p{L}])/giu, 'alakart'],
      [/\bm²|\bm2\b/g, 'metrekare'],
      [/(\d)\s*km\b/g, '$1 kilometre'], [/(\d)\s*mt?\b(?![a-zçğıöşü])/g, '$1 metre'],
      [/(\d)\s*\*/g, '$1 yıldız'],
    ],
  },

  en: {
    thousandsSep: ',',
    months: ['', 'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'],
    formatDate: (d, month, year) => `${month} ${d}${year ? `, ${year}` : ''}`,
    rangeWord: 'to',
    digits: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
    currency: { tl: 'Turkish lira', '₺': 'Turkish lira', try: 'Turkish lira', '€': 'euro', eur: 'euro', euro: 'euro', $: 'dollars', usd: 'dollars' },
    abbreviations: [
      ...boardCodes({
        uai: 'ultra all inclusive', ai: 'all inclusive', hb: 'half board',
        fb: 'full board', bb: 'bed and breakfast', ro: 'room only',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'guests'],
      [/\bC\s*\/\s*In\b/gi, 'check-in'], [/\bC\s*\/\s*Out\b/gi, 'check-out'],
      [/\bstop\s*sale\b/gi, 'closed for sale'],
      [/\bm²|\bm2\b/g, 'square metres'],
      [/(\d)\s*\*/g, '$1 star'],
    ],
  },

  de: {
    // German already writes 25.900 — the engine reads it correctly.
    thousandsSep: '.',
    months: ['', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
      'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    formatDate: (d, month, year) => `${d}. ${month}${year ? ` ${year}` : ''}`,
    timeWord: 'um',
    rangeWord: 'bis',
    digits: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
    currency: { tl: 'türkische Lira', '₺': 'türkische Lira', try: 'türkische Lira', '€': 'Euro', eur: 'Euro', euro: 'Euro', $: 'Dollar', usd: 'Dollar' },
    abbreviations: [
      ...boardCodes({
        uai: 'Ultra All Inclusive', ai: 'All Inclusive', hb: 'Halbpension',
        fb: 'Vollpension', bb: 'Übernachtung mit Frühstück', ro: 'nur Übernachtung',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'Personen'],
      [/\bC\s*\/\s*In\b/gi, 'Anreise'], [/\bC\s*\/\s*Out\b/gi, 'Abreise'],
      [/\bcheck[-\s]?in\b/gi, 'Anreise'], [/\bcheck[-\s]?out\b/gi, 'Abreise'],
      [/\bstop\s*sale\b/gi, 'nicht buchbar'],
      [/\bm²|\bm2\b/g, 'Quadratmeter'],
      [/(\d)\s*\*/g, '$1 Sterne'],
    ],
  },

  ru: {
    thousandsSep: ' ',
    months: ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    formatDate: (d, month, year) => `${d} ${month}${year ? ` ${year}` : ''}`,
    rangeWord: 'по',
    digits: ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
    currency: { tl: 'турецких лир', '₺': 'турецких лир', try: 'турецких лир', '€': 'евро', eur: 'евро', euro: 'евро', $: 'долларов', usd: 'долларов' },
    abbreviations: [
      ...boardCodes({
        uai: 'ультра всё включено', ai: 'всё включено', hb: 'полупансион',
        fb: 'полный пансион', bb: 'завтрак включён', ro: 'только проживание',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'гостей'],
      [/\bC\s*\/\s*In\b/gi, 'заезд'], [/\bC\s*\/\s*Out\b/gi, 'выезд'],
      [/\bcheck[-\s]?in\b/gi, 'заезд'], [/\bcheck[-\s]?out\b/gi, 'выезд'],
      [/\bm²|\bm2\b/g, 'квадратных метров'],
      [/(\d)\s*\*/g, '$1 звезды'],
    ],
  },

  fr: {
    thousandsSep: ' ',
    months: ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    formatDate: (d, month, year) => `${d} ${month}${year ? ` ${year}` : ''}`,
    timeWord: 'à',
    rangeWord: 'au',
    digits: ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'],
    currency: { tl: 'livres turques', '₺': 'livres turques', try: 'livres turques', '€': 'euros', eur: 'euros', euro: 'euros', $: 'dollars', usd: 'dollars' },
    abbreviations: [
      ...boardCodes({
        uai: 'ultra tout compris', ai: 'tout compris', hb: 'demi-pension',
        fb: 'pension complète', bb: 'chambre et petit-déjeuner', ro: 'chambre seule',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'personnes'],
      [/\bC\s*\/\s*In\b/gi, 'arrivée'], [/\bC\s*\/\s*Out\b/gi, 'départ'],
      [/\bcheck[-\s]?in\b/gi, 'arrivée'], [/\bcheck[-\s]?out\b/gi, 'départ'],
      [/\bm²|\bm2\b/g, 'mètres carrés'],
      [/(\d)\s*\*/g, '$1 étoiles'],
    ],
  },

  sv: {
    thousandsSep: ' ',
    months: ['', 'januari', 'februari', 'mars', 'april', 'maj', 'juni',
      'juli', 'augusti', 'september', 'oktober', 'november', 'december'],
    formatDate: (d, month, year) => `${d} ${month}${year ? ` ${year}` : ''}`,
    rangeWord: 'till',
    digits: ['noll', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio'],
    currency: { tl: 'turkiska lira', '₺': 'turkiska lira', try: 'turkiska lira', '€': 'euro', eur: 'euro', euro: 'euro', $: 'dollar', usd: 'dollar' },
    abbreviations: [
      ...boardCodes({
        uai: 'ultra all inclusive', ai: 'all inclusive', hb: 'halvpension',
        fb: 'helpension', bb: 'rum med frukost', ro: 'endast rum',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'gäster'],
      [/\bm²|\bm2\b/g, 'kvadratmeter'],
      [/(\d)\s*\*/g, '$1 stjärnor'],
    ],
  },

  el: {
    thousandsSep: '.',
    months: ['', 'Ιανουαρίου', 'Φεβρουαρίου', 'Μαρτίου', 'Απριλίου', 'Μαΐου', 'Ιουνίου',
      'Ιουλίου', 'Αυγούστου', 'Σεπτεμβρίου', 'Οκτωβρίου', 'Νοεμβρίου', 'Δεκεμβρίου'],
    formatDate: (d, month, year) => `${d} ${month}${year ? ` ${year}` : ''}`,
    rangeWord: 'έως',
    digits: ['μηδέν', 'ένα', 'δύο', 'τρία', 'τέσσερα', 'πέντε', 'έξι', 'επτά', 'οκτώ', 'εννέα'],
    currency: { tl: 'τουρκικές λίρες', '₺': 'τουρκικές λίρες', try: 'τουρκικές λίρες', '€': 'ευρώ', eur: 'ευρώ', euro: 'ευρώ', $: 'δολάρια', usd: 'δολάρια' },
    abbreviations: [
      ...boardCodes({
        uai: 'ultra all inclusive', ai: 'όλα συμπεριλαμβάνονται', hb: 'ημιδιατροφή',
        fb: 'πλήρης διατροφή', bb: 'πρωινό', ro: 'μόνο δωμάτιο',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'άτομα'],
      [/\bm²|\bm2\b/g, 'τετραγωνικά μέτρα'],
      [/(\d)\s*\*/g, '$1 αστέρων'],
    ],
  },

  ar: {
    thousandsSep: ',',
    months: ['', 'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
    formatDate: (d, month, year) => `${d} ${month}${year ? ` ${year}` : ''}`,
    rangeWord: 'إلى',
    digits: ['صفر', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'],
    currency: { tl: 'ليرة تركية', '₺': 'ليرة تركية', try: 'ليرة تركية', '€': 'يورو', eur: 'يورو', euro: 'يورو', $: 'دولار', usd: 'دولار' },
    abbreviations: [
      ...boardCodes({
        uai: 'شامل جميع الخدمات الفاخرة', ai: 'شامل جميع الخدمات', hb: 'نصف إقامة',
        fb: 'إقامة كاملة', bb: 'مبيت وإفطار', ro: 'غرفة فقط',
      }),
      ...commonFacilities,
      [/\bPAX\b/gi, 'أشخاص'],
      [/\bm²|\bm2\b/g, 'متر مربع'],
      [/(\d)\s*\*/g, '$1 نجوم'],
    ],
  },
}

/** The profile for a language, falling back to Turkish (the primary market). */
function localeFor(lang) {
  const code = String(lang || 'tr').toLowerCase().split(/[-_]/)[0]
  return LOCALES[code] || LOCALES.tr
}

module.exports = { LOCALES, localeFor, numberToTurkish }
