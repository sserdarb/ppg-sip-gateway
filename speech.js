// speech.js — turn model output into something a TTS engine reads like a human.
//
// Two live-call defects drove this file:
//
//   1. The agent said "YILDIZ YILDIZ" out loud. Models emit markdown emphasis
//      ("**25.900 TL**") and the speech engine reads the asterisks. Nothing in
//      a phone call should ever contain formatting.
//
//   2. Numbers came out digit by digit ("iki beş dokuz sıfır sıfır"). Asking the
//      MODEL to spell them produced nonsense instead ("iki beş bin doksan yüz"
//      for 25.900 — measured), so the conversion has to be deterministic code.
//
// Only what is spoken passes through here; the [[ACTION]] channel is stripped
// before this point.

// ── Turkish numerals ────────────────────────────────────────────────────────
const ONES = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz']
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan']
const SCALES = [
  { v: 1e9, w: 'milyar' },
  { v: 1e6, w: 'milyon' },
  { v: 1e3, w: 'bin' },
]

/** 0-999 in Turkish. "yüz" and "bin" never take a leading "bir". */
function underThousand(n) {
  const out = []
  const h = Math.floor(n / 100)
  if (h) out.push(h === 1 ? 'yüz' : `${ONES[h]} yüz`)
  const rest = n % 100
  const t = Math.floor(rest / 10)
  if (t) out.push(TENS[t])
  const o = rest % 10
  if (o) out.push(ONES[o])
  return out.join(' ')
}

/** Whole number → Turkish words. 25900 → "yirmi beş bin dokuz yüz". */
function numberToTurkish(n) {
  n = Math.round(Math.abs(n))
  if (n === 0) return 'sıfır'
  const parts = []
  let left = n
  for (const { v, w } of SCALES) {
    const count = Math.floor(left / v)
    if (count) {
      // "bin" alone, never "bir bin" — but "bir milyon" IS correct.
      parts.push(count === 1 && w === 'bin' ? 'bin' : `${underThousand(count)} ${w}`)
      left -= count * v
    }
  }
  if (left) parts.push(underThousand(left))
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// ── markdown / formatting ───────────────────────────────────────────────────
/**
 * Remove anything a speech engine would pronounce as punctuation noise.
 * Emphasis markers are the loud one ("yıldız yıldız"), but bullets, headings,
 * code fences and link syntax all read badly too.
 */
/**
 * Machine syntax must NEVER reach the speech engine.
 *
 * A caller heard "<function=check_availability>{checkIn 2026-09-20...}"
 * read out as code. The agent is supposed to emit tool calls on the API
 * channel or as [[ACTION ...]], and the turn logic strips those — but a model
 * that writes a call in some third format of its own slips straight past.
 *
 * So this is a LAST LINE OF DEFENCE and deliberately broad: anything shaped
 * like a call, a tag or a raw JSON object is silently dropped rather than
 * spoken. Losing a stray brace is harmless; reading JSON to a guest is not.
 */
function stripMachineSyntax(text) {
  return String(text || '')
    // <function=name>{...}</function> and any stray XML-ish tag
    .replace(/<function=[\s\S]*?<\/function>/gi, ' ')
    .replace(/<\/?[a-z_][\w:-]*[^>]*>/gi, ' ')
    // the agreed directive channel, in case the turn logic missed it
    .replace(/\[\[ACTION[\s\S]*?\]\]/gi, ' ')
    .replace(/\[\[[\s\S]*?\]\]/g, ' ')
    // a bare JSON object left mid-sentence
    .replace(/\{\s*"[\s\S]*?\}/g, ' ')
    // fenced code
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripMarkup(text) {
  return String(text || '')
    // links: [etiket](url) → etiket
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // emphasis / code / headings — the actual "yıldız yıldız" culprit
    .replace(/[*_`~]+/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    // list bullets at the start of a line
    .replace(/^\s*[-•·]\s+/gm, '')
    // leftover table pipes
    .replace(/\s*\|\s*/g, ' ')
    // emoji and pictographs have no spoken form
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// ── numbers in context ──────────────────────────────────────────────────────
// "TL" was left as-is and the engine read it "te le". The word a Turkish
// speaker uses for the amount is "lira".
const CURRENCY_WORD = {
  'tl': 'lira', '₺': 'lira', 'try': 'lira',
  '€': 'Euro', 'eur': 'Euro', 'euro': 'Euro',
  '$': 'Dolar', 'usd': 'Dolar',
}

const MONTHS = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']

/**
 * Dates and times are quantities too, and a machine format read aloud is just
 * as bad as digit-by-digit: "2026-08-20" comes out "iki bin yirmi altı tire
 * sıfır sekiz tire yirmi". Turn them into what a person would say.
 *
 * The YEAR is dropped when it is the current one — nobody says "twenty
 * twenty-six" about next month — but kept when it is not, because that is
 * exactly when it carries information.
 */
function speakDatesAndTimes(text) {
  const thisYear = new Date().getFullYear()
  return String(text || '')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
      const month = MONTHS[parseInt(mo, 10)]
      if (!month) return m
      const day = parseInt(d, 10)
      const year = parseInt(y, 10)
      return year === thisYear ? `${day} ${month}` : `${day} ${month} ${numberToTurkish(year)}`
    })
    // The leading "saat" is added only when the sentence does not already have
    // one — "check-in saat 14:00" was coming out "saat saat on dört".
    .replace(/(\bsaat\s+)?\b(\d{1,2}):(\d{2})\b/gi, (m, pre, h, mi) => {
      const hour = parseInt(h, 10)
      const min = parseInt(mi, 10)
      if (hour > 23 || min > 59) return m
      const body = min === 0
        ? numberToTurkish(hour)
        : `${numberToTurkish(hour)} ${numberToTurkish(min)}`
      return pre ? `${pre}${body}` : `saat ${body}`
    })
}

/**
 * Hotel jargon, said the way a receptionist says it.
 *
 * The engine spelled "SPA" out as "S-P-A" — it reads a short all-caps token as
 * an initialism, which is right for PNR and wrong for spa. And the board codes
 * are worse than mispronounced: "UAI" read as three letters means nothing to a
 * guest, while "ultra her şey dahil" is the actual product being sold.
 *
 * So every abbreviation this business uses is listed here with what a person
 * would SAY, rather than patched one complaint at a time. Order matters —
 * longer codes first, so UAI is not consumed by AI.
 */
const ABBREVIATIONS = [
  // Board / concept codes. These are products, not letters.
  [/\bU\.?A\.?L\.?L\b/gi, 'ultra her şey dahil'],
  [/\bU\.?A\.?I\b/gi, 'ultra her şey dahil'],
  [/\bA\.?L\.?L\b(?!\s*[a-zçğıöşü])/g, 'her şey dahil'],
  [/\bA\.?I\b(?![-\s]*(?:destek|asistan|yapay))/g, 'her şey dahil'],
  [/\bH\.?B\b/g, 'yarım pansiyon'],
  [/\bF\.?B\b/g, 'tam pansiyon'],
  [/\bB\.?B\b/g, 'oda kahvaltı'],
  [/\bR\.?O\b/g, 'sadece oda'],
  [/\bO\.?B\b/g, 'sadece oda'],
  // Facilities the engine either spells out or reads in English.
  [/\bSPA\b/g, 'spa'],
  [/\bWi[-\s]?Fi\b/gi, 'vay fay'],
  [/\bWIFI\b/g, 'vay fay'],
  [/\bT\.?V\b/g, 'televizyon'],
  [/\bW\.?C\b/g, 'tuvalet'],
  [/\bA\/?C\b/g, 'klima'],
  [/\bF\s*&\s*B\b/gi, 'yiyecek içecek'],
  [/\bVIP\b/g, 'vip'],
  // Operations vocabulary.
  [/\bPAX\b/gi, 'kişi'],
  [/\bC\s*\/\s*In\b/gi, 'giriş'],
  [/\bC\s*\/\s*Out\b/gi, 'çıkış'],
  [/\bcheck[-\s]?in\b/gi, 'çekin'],
  [/\bcheck[-\s]?out\b/gi, 'çekaut'],
  [/\bno[-\s]?show\b/gi, 'gelmeme'],
  [/\bstop\s*sale\b/gi, 'satışa kapalı'],
  // No \b before "à": it is not an ASCII word character, so the boundary never
  // matches — the same trap that broke the Turkish intent regexes.
  [/(?<![\p{L}])[aà]\s*la\s*carte(?![\p{L}])/giu, 'alakart'],
  // Units.
  [/\bm²|\bm2\b/g, 'metrekare'],
  [/(\d)\s*km\b/g, '$1 kilometre'],
  [/(\d)\s*mt?\b(?![a-zçğıöşü])/g, '$1 metre'],
  [/(\d)\s*\*/g, '$1 yıldız'],
]

function expandAbbreviations(text) {
  let out = String(text || '')
  for (const [re, word] of ABBREVIATIONS) out = out.replace(re, word)
  return out
}

/** Digit-by-digit, the way a person reads a number back to confirm it. */
const DIGIT_WORDS = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz']
const digitsToTurkish = (s) =>
  String(s).replace(/\D/g, '').split('').map(d => DIGIT_WORDS[Number(d)]).join(' ')

/**
 * Hyphens. The engine pronounces every one of them as "tire", so a caller hears
 * "yirmi TİRE yirmi beş Eylül" and "çek TİRE in".
 *
 * Three different things wear the same character, and each needs its own
 * reading:
 *   phone-like runs  → digit by digit, which is how a number gets confirmed
 *   numeric ranges   → "20 ile 25"
 *   inside a word    → just a space ("check-in" → "check in")
 *
 * Phones are handled FIRST and their digits are spelled here, because leaving
 * them to the number pass turned "0532-111-22-33" into
 * "beş yüz otuz iki-111-22-33" — a leading zero silently dropped from a phone
 * number the guest just dictated.
 */
function speakSeparators(text) {
  return String(text || '')
    // 0532-111-22-33 / 0212 345 67 89 — three or more groups, or 10+ digits.
    .replace(/\b\d[\d\s-]{8,}\d\b/g, (m) => {
      const digits = m.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 15) return m
      return digitsToTurkish(digits)
    })
    // 20-25 Eylül · 14-16 kişi — a span, not a subtraction.
    .replace(/\b(\d{1,4})\s*[-–]\s*(\d{1,4})\b/g, '$1 ile $2')
    // check-in, e-posta, Wi-Fi — the hyphen carries no sound.
    .replace(/(\p{L})[-–](\p{L})/gu, '$1 $2')
}

// Patterns that must never be treated as plain quantities.
const ISO_DATE = /\d{4}-\d{2}-\d{2}/
const CLOCK = /\d{1,2}:\d{2}/

/**
 * Spell out amounts, leaving dates, times and long digit runs alone.
 *
 * A phone number or a reservation code SHOULD be read digit by digit, and a
 * date read as words would be worse than the numeral — so the rule is narrow
 * on purpose: thousands-separated figures, and plain integers that are either
 * large or sitting next to a currency.
 */
function speakNumbers(text) {
  let out = String(text || '')

  // Protect dates and clock times from every rule below.
  const guards = []
  out = out.replace(new RegExp(`${ISO_DATE.source}|${CLOCK.source}`, 'g'), (m) => {
    guards.push(m)
    return ` ${guards.length - 1} `
  })

  // "25.900 TL" / "1.320 €" / "25900 TL" → words + currency word
  out = out.replace(
    /(\d[\d.,]*)\s*(TL|TRY|₺|EUR|€|Euro|USD|\$)/gi,
    (_m, num, cur) => {
      const n = parseInt(String(num).replace(/[.,]/g, ''), 10)
      if (!Number.isFinite(n)) return _m
      const word = CURRENCY_WORD[String(cur).toLowerCase()] || cur
      return `${numberToTurkish(n)} ${word}`
    },
  )

  // Bare thousands-separated figures ("25.900") and plain integers ≥ 1000.
  out = out.replace(/\b(\d{1,3}(?:\.\d{3})+|\d{4,9})\b/g, (m) => {
    const digits = m.replace(/\./g, '')
    // A long unbroken run is an identifier (phone, PNR) — leave it to be read
    // digit by digit, which is what a human would do too.
    if (!m.includes('.') && digits.length > 6) return m
    const n = parseInt(digits, 10)
    return Number.isFinite(n) ? numberToTurkish(n) : m
  })

  return out.replace(/ (\d+) /g, (_m, i) => guards[Number(i)])
}

/**
 * Everything that must happen between the model and the speech engine.
 */
function sanitizeForSpeech(text) {
  // Order is load-bearing: ISO dates own their hyphens, so they must become
  // words BEFORE the separator pass; phones must be spelled there before the
  // number pass can mistake a group for a quantity.
  // Abbreviations expand BEFORE the separator pass, so "Wi-Fi" and "C/In" are
  // already words by the time hyphens and slashes are dealt with.
  return speakNumbers(speakSeparators(
    expandAbbreviations(speakDatesAndTimes(stripMarkup(stripMachineSyntax(text)))),
  ))
    // Turkish attaches suffixes to NUMERALS with an apostrophe ("14:00'te"),
    // but once the numeral is a word the apostrophe is wrong and the engine
    // stumbles on it: "on dört'te" should simply be "on dörtte". Dropping it
    // between two letters is safe — "Belconti'ye" reads the same either way.
    .replace(/(\p{L})['’](\p{L})/gu, '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

module.exports = {
  sanitizeForSpeech, stripMarkup, stripMachineSyntax, speakNumbers,
  speakDatesAndTimes, speakSeparators, expandAbbreviations,
  numberToTurkish, digitsToTurkish, ABBREVIATIONS,
}
