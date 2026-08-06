// intent-router.js — layer 1 of the modular prompt set.
//
// A tiny, ultra-fast classifier that reads the caller's first words and tells
// the main agent WHAT KIND OF CALL this is. The main agent then loads the
// matching few-shot dialogue pack, and the post-call engine gets a CRM intent
// for free.
//
// Why a separate model instead of asking the 70B agent: llama-3.1-8b-instant
// answers in ~200-300ms, which fits inside the "bir saniye" filler. Asking the
// big model to both classify and converse made it narrate its classification
// out loud.
//
// A regex pre-classifier runs first: it is free, instant, and catches the
// unambiguous cases (an angry caller demanding a human must never wait on a
// network round-trip). The LLM only runs when the regex is not confident.

const { chatJson, GROQ_LLM_FALLBACK } = require('./providers')

const LOG = (...a) => console.log('[router]', ...a)

const ROUTER_MODEL = process.env.AI_ROUTER_MODEL || GROQ_LLM_FALLBACK
const ROUTER_TIMEOUT_MS = parseInt(process.env.AI_ROUTER_TIMEOUT_MS || '1200', 10)
const ROUTER_ENABLED = process.env.AI_ROUTER_ENABLED !== '0'

const INTENTS = ['RESERVATION_NEW', 'RESERVATION_EXISTING', 'HOTEL_INFO', 'COMPLAINT_URGENT', 'UNKNOWN']

const SYSTEM_PROMPT =
  `# ROL\n` +
  `Sen otel çağrı merkezine gelen sesli aramaların ilk saniyelerinde niyet tespiti yapan ultra-hızlı bir yönlendiricisin.\n\n` +
  `# GÖREV\n` +
  `Kullanıcının ses transkriptini analiz et ve aşağıdaki kategorilerden EN UYGUN olanını seç. Yanıt olarak YALNIZCA JSON ver, açıklama yazma.\n\n` +
  `# KATEGORİLER\n` +
  `- RESERVATION_NEW: Yeni konaklama, fiyat, oda bilgisi, tarih/müsaitlik sorgulama.\n` +
  `- RESERVATION_EXISTING: Mevcut rezervasyon değiştirme, iptal, konfirmasyon sorgulama.\n` +
  `- HOTEL_INFO: Konum, transfer, evcil hayvan, konsept, havuz/plaj, check-in/out saatleri.\n` +
  `- COMPLAINT_URGENT: Şikayet, yetkili/insan talebi, fiyat pazarlığı ısrarı.\n` +
  `- UNKNOWN: Anlaşılmayan veya belirsiz ifadeler.\n\n` +
  `# ÇIKTI FORMATI (yalnızca geçerli JSON)\n` +
  `{"intent":"RESERVATION_NEW","confidence":0.95,"summary_key":"2 yetişkin 1 çocuk için Temmuz ayı fiyat sorgusu"}`

// Turkish letters are not \w in JavaScript, so \b cannot be trusted here.
// LEFT boundary only: a pattern must start a word, but Turkish suffixes may
// follow it ("fiyat" still matches "fiyatlarınız", "müsait" matches
// "müsaitliğiniz"). Without this, short tokens matched INSIDE longer words —
// "gece" fired on "gecen sefer" and misrouted a complaint to RESERVATION_NEW.
const TR_LETTER = 'a-zçğıöşüâîû'
const startsWord = (body) => new RegExp(`(?<![${TR_LETTER}])(?:${body})`, 'i')

// Unambiguous surface patterns — free and instant. Order matters: escalation
// beats everything else, because a caller asking for a human while also asking
// a price is still an escalation.
const RULES = [
  {
    intent: 'COMPLAINT_URGENT', confidence: 0.95,
    re: startsWord('insana|müşteri temsilcis|yetkili|müdür|şikayet|rezalet|berbat|dava(?![' + TR_LETTER + '])|iade etmiyor|çok pahalı|indirim yapın|pazarlık|sorun yaşa|memnun kalmad|geri ödeme'),
  },
  {
    intent: 'RESERVATION_EXISTING', confidence: 0.9,
    re: startsWord('rezervasyonumu|rezervasyonum var|iptal et|değiştir|erteley|konfirme|voucher|kaydım|pnr(?![' + TR_LETTER + '])'),
  },
  {
    intent: 'RESERVATION_NEW', confidence: 0.85,
    // "gece" needs a RIGHT boundary too ("gecen"≠"gece"), so the useful
    // inflections are spelled out instead of relying on a prefix match.
    re: startsWord('fiyat|ne kadar|kaç para|müsait|boş oda|boş yer|rezervasyon yaptır|konaklama|gece(?![' + TR_LETTER + '])|gecelik|geceleme|kişilik oda'),
  },
  {
    intent: 'HOTEL_INFO', confidence: 0.85,
    re: startsWord('nerede|konum|adres|transfer|havaalan|havaliman|evcil|köpek|kedi|konsept|her şey dahil|herşey dahil|plaj|havuz|check.?in|check.?out|giriş saat|çıkış saat|otopark|wifi|spa(?![' + TR_LETTER + '])'),
  },
]

/** Free pre-classifier. Returns null when nothing matches confidently. */
function ruleClassify(text) {
  const t = (text || '').trim()
  if (t.length < 3) return { intent: 'UNKNOWN', confidence: 0.5, summary_key: t, source: 'rule' }
  for (const r of RULES) {
    if (r.re.test(t)) return { intent: r.intent, confidence: r.confidence, summary_key: t.slice(0, 120), source: 'rule' }
  }
  return null
}

function normalize(raw, fallbackText) {
  if (!raw || typeof raw !== 'object') return null
  const intent = INTENTS.includes(raw.intent) ? raw.intent : 'UNKNOWN'
  let confidence = Number(raw.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) confidence = 0.5
  return {
    intent,
    confidence,
    summary_key: String(raw.summary_key || fallbackText || '').slice(0, 160),
    source: 'llm',
  }
}

/**
 * Classify one caller utterance.
 * @param {string} text      the STT transcript of the turn
 * @param {string[]} [recent] previous caller lines, for context on short replies
 * @returns {Promise<{intent:string, confidence:number, summary_key:string, source:string}>}
 */
async function classifyIntent(text, recent = []) {
  const quick = ruleClassify(text)
  // A confident rule hit is as good as the model and costs nothing.
  if (quick && quick.confidence >= 0.85) return quick
  if (!ROUTER_ENABLED) return quick || { intent: 'UNKNOWN', confidence: 0.3, summary_key: text, source: 'disabled' }

  const context = recent.length ? `Önceki konuşma:\n${recent.slice(-3).join('\n')}\n\n` : ''
  const raw = await chatJson(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${context}Şu anki transkript: "${text}"` },
    ],
    { model: ROUTER_MODEL, maxTokens: 120, timeoutMs: ROUTER_TIMEOUT_MS, temperature: 0 },
  ).catch(() => null)

  const parsed = normalize(raw, text)
  if (parsed) return parsed
  // Model unavailable or malformed → keep the weak rule guess rather than nothing.
  return quick || { intent: 'UNKNOWN', confidence: 0.3, summary_key: String(text || '').slice(0, 160), source: 'fallback' }
}

/**
 * A single line appended to the system prompt telling the agent what the
 * router concluded. Keeps the steer explicit and auditable in the logs instead
 * of hiding it in retrieval.
 */
function intentDirective(result) {
  if (!result) return ''
  const map = {
    RESERVATION_NEW: 'Misafir YENİ REZERVASYON/fiyat için arıyor. Fiyat vermeden önce giriş-çıkış tarihi, yetişkin sayısı ve çocuk yaşlarını tamamla; tamamlanınca müsaitlik sorgusunu çalıştır.',
    RESERVATION_EXISTING: 'Misafirin MEVCUT REZERVASYONU var. Önce rezervasyon sahibinin adını ve giriş tarihini al; iptal/değişiklik kesinleştirme yetkisi sende DEĞİL, koşulları anlat ve gerekirse rezervasyon ekibine aktar.',
    HOTEL_INFO: 'Misafir OTEL BİLGİSİ istiyor. Yanıtı otel bilgi bankasından ver, kısa tut ve ardından rezervasyon niyetini nazikçe yokla.',
    COMPLAINT_URGENT: 'ŞİKAYET/ESKALASYON sinyali var. Önce empati kur, savunmaya geçme, çözüm sun; ısrar sürerse insana aktarma aksiyonunu çalıştır.',
    UNKNOWN: '',
  }
  const line = map[result.intent] || ''
  return line ? `\n\n=== BU ÇAĞRININ TESPİT EDİLEN NİYETİ: ${result.intent} ===\n${line}` : ''
}

module.exports = { classifyIntent, intentDirective, INTENTS, ruleClassify }
