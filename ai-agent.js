// ai-agent.js — Multilingual AI concierge for the AI extension (default 7000).
//
// Pipeline: caller audio (PCMU/RTP) → energy VAD → STT cascade (providers.js:
// Deepgram Nova-2 / Groq whisper-large-v3-turbo / self-hosted Whisper, all fed
// the hotel's custom vocabulary) → intent router (intent-router.js) → main LLM
// with intent-matched few-shot examples → TTS cascade (ElevenLabs Turbo /
// Cartesia Sonic / Groq Orpheus / Google) → PCMU/RTP back.
//
// The agent has two real tools: check_availability (live rooms + prices from
// PMS via PPG) and transfer (hand the leg to a human department). Both travel
// on the [[ACTION {...}]] channel, which is stripped before speech.

const dgram = require('dgram')
const os = require('os')

const { ulawByteToPcm } = require('./audio')
const { transcribe, synthesize, chatStream, buildVocabulary, providerStatus } = require('./providers')
const { classifyIntent, intentDirective } = require('./intent-router')

function detectIp() {
  const ifs = os.networkInterfaces()
  for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address
  return '127.0.0.1'
}

// ── static config ────────────────────────────────────────────────────────────
const AI_EXT      = process.env.AI_EXTENSION || '7000'
const AI_RTP_PORT = parseInt(process.env.AI_RTP_PORT || '5071', 10)
const PUBLIC_IP   = process.env.AI_RTP_IP || detectIp()
const HOTEL       = process.env.AI_HOTEL_NAME || 'otelimiz'
const LOG = (...a) => console.log('[ai]', ...a)

// Voice upgrade / override.
//
// PPG ships the canonical profile list, which still names the classic WaveNet
// voices. WaveNet is what made the agent sound mechanical on a real call, so
// Turkish is remapped to Chirp3-HD (Google's generative tier, available on the
// same key, 30 Turkish voices, ~200ms slower per sentence — hidden by
// sentence-streaming).
//
// Overridable per profile id so a voice can be swapped after listening to
// samples, without waiting on a PPG deploy:
//   AI_VOICE_OVERRIDE={"female-tr":"tr-TR-Chirp3-HD-Kore","male-tr":"tr-TR-Chirp3-HD-Puck"}
const DEFAULT_VOICE_OVERRIDE = {
  'female-tr': process.env.AI_VOICE_TR_FEMALE || 'tr-TR-Chirp3-HD-Achernar',
  'male-tr': process.env.AI_VOICE_TR_MALE || 'tr-TR-Chirp3-HD-Charon',
}
let VOICE_OVERRIDE = DEFAULT_VOICE_OVERRIDE
try {
  if (process.env.AI_VOICE_OVERRIDE) {
    VOICE_OVERRIDE = { ...DEFAULT_VOICE_OVERRIDE, ...JSON.parse(process.env.AI_VOICE_OVERRIDE) }
  }
} catch { console.error('[ai] AI_VOICE_OVERRIDE is not valid JSON — using defaults') }

/** Apply the override map to a profile list, leaving gender/name/lang intact. */
function applyVoiceOverride(profiles) {
  return profiles.map(p => (VOICE_OVERRIDE[p.id] ? { ...p, voice: VOICE_OVERRIDE[p.id] } : p))
}

// STT language handling:
//   adaptive (default) — turn 1 auto-detects; once the SAME language comes back
//                        twice in a row it is pinned for the rest of the call.
//                        Auto-detect on 8kHz telephony audio is the documented
//                        cause of garbled Turkish, but pinning from turn 1 would
//                        break the multilingual switch — this gets both.
//   pin                — always pin the active voice profile's language.
//   auto               — never pin (legacy behaviour).
const STT_LANG_MODE = (process.env.AI_STT_LANG_MODE || 'adaptive').toLowerCase()

// ── built-in voice profiles (overridable via constructor) ────────────────────
// Voice genders VERIFIED live against Google TTS voices.list (2026-06-14).
// CRITICAL: tr-TR-Wavenet-E is MALE — it was wrongly used for the "Ayşe" female
// profile, so callers heard a male voice. Female TR = tr-TR-Wavenet-D.
// Names are NATIVE AND CURRENT per language, not textbook stereotypes: a German
// caller greeted by "Greta" or a Russian one by "Наташа" hears a foreigner's
// idea of their country. Kept in sync with PPG's BUILTIN_VOICE_PROFILES, which
// is the canonical list — this one is only the fallback when PPG is unreachable.
// `agentName` is the bare name the agent introduces itself with (PPG's `name`
// carries a "(TR - Kadın)" suffix meant for the admin dropdown, which must
// never be spoken).
const BUILTIN_PROFILES = [
  { id: 'female-tr', name: 'Elif',      agentName: 'Elif',      gender: 'female', lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-D' },
  { id: 'male-tr',   name: 'Emre',      agentName: 'Emre',      gender: 'male',   lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-B' },
  { id: 'female-en', name: 'Emily',     agentName: 'Emily',     gender: 'female', lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-F' },
  { id: 'male-en',   name: 'James',     agentName: 'James',     gender: 'male',   lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-D' },
  { id: 'female-de', name: 'Lena',      agentName: 'Lena',      gender: 'female', lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-F' },
  { id: 'male-de',   name: 'Lukas',     agentName: 'Lukas',     gender: 'male',   lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-B' },
  { id: 'female-ru', name: 'Анна',      agentName: 'Анна',      gender: 'female', lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-A' },
  { id: 'male-ru',   name: 'Александр', agentName: 'Александр', gender: 'male',   lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-B' },
  { id: 'female-sv', name: 'Maja',      agentName: 'Maja',      gender: 'female', lang: 'sv-SE', whisperCode: 'sv', voice: 'sv-SE-Wavenet-A' },
  { id: 'male-sv',   name: 'Erik',      agentName: 'Erik',      gender: 'male',   lang: 'sv-SE', whisperCode: 'sv', voice: 'sv-SE-Wavenet-B' },
  { id: 'female-fr', name: 'Camille',   agentName: 'Camille',   gender: 'female', lang: 'fr-FR', whisperCode: 'fr', voice: 'fr-FR-Wavenet-A' },
  { id: 'male-fr',   name: 'Lucas',     agentName: 'Lucas',     gender: 'male',   lang: 'fr-FR', whisperCode: 'fr', voice: 'fr-FR-Wavenet-B' },
  { id: 'female-ar', name: 'نور',       agentName: 'نور',       gender: 'female', lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-A' },
  { id: 'male-ar',   name: 'عمر',       agentName: 'عمر',       gender: 'male',   lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-B' },
  { id: 'female-el', name: 'Eleni',     agentName: 'Eleni',     gender: 'female', lang: 'el-GR', whisperCode: 'el', voice: 'el-GR-Wavenet-A' },
  { id: 'male-el',   name: 'Nikos',     agentName: 'Nikos',     gender: 'male',   lang: 'el-GR', whisperCode: 'el', voice: 'el-GR-Wavenet-B' },
]

/** The bare name to speak for a profile — never the admin dropdown label. */
const profileAgentName = (p) => (p && (p.agentName || p.name)) || 'Asistan'

// "Buying time" fillers per language — spoken instantly when the caller stops
// so they hear acknowledgement while STT+LLM run (covers response latency).
// Short, NEUTRAL acknowledgements: they fit any turn (chat or lookup) and just
// signal "I'm with you". Large, varied pools — picked randomly and only
// occasionally (STT is ~0.4s with Groq, so rotating 3 phrases sounded robotic).
const FILLERS = {
  tr: ['Tabii efendim.', 'Hemen bakıyorum.', 'Bir saniye lütfen.', 'Elbette.', 'Memnuniyetle.', 'Tabii ki.', 'Hemen kontrol ediyorum.', 'Şöyle bakalım.'],
  en: ['Of course.', 'One moment please.', 'Let me check.', 'Certainly.', 'Right away.', 'Sure thing.', 'Let me see.'],
  de: ['Natürlich.', 'Einen Moment bitte.', 'Ich schaue gleich.', 'Gerne.', 'Sofort.', 'Mal sehen.'],
  ru: ['Конечно.', 'Минутку, пожалуйста.', 'Сейчас посмотрю.', 'С удовольствием.', 'Один момент.'],
  ar: ['بالتأكيد.', 'لحظة من فضلك.', 'سأتحقق حالًا.', 'بكل سرور.', 'حالًا.'],
  sv: ['Självklart.', 'Ett ögonblick.', 'Jag kollar genast.', 'Visst.', 'Strax.'],
  fr: ['Bien sûr.', 'Un moment, s\'il vous plaît.', 'Je vérifie.', 'Certainement.', 'Tout de suite.'],
  el: ['Βεβαίως.', 'Μια στιγμή παρακαλώ.', 'Τσεκάρω αμέσως.', 'Ευχαρίστως.', 'Αμέσως.'],
}

// Longer "I'm querying the system" lines — used only while a real tool call
// (availability lookup) is running, where the wait is genuinely a lookup.
const LOOKUP_FILLERS = {
  tr: 'Tarihlerinizi sistemden kontrol ediyorum, lütfen hatta kalın.',
  en: 'Let me check those dates in the system, please stay on the line.',
  de: 'Ich prüfe die Termine im System, bitte bleiben Sie dran.',
  ru: 'Проверяю эти даты в системе, оставайтесь на линии.',
  ar: 'أتحقق من هذه التواريخ في النظام، يرجى الانتظار.',
  sv: 'Jag kollar datumen i systemet, var god dröj.',
  fr: 'Je vérifie ces dates dans le système, restez en ligne.',
  el: 'Ελέγχω αυτές τις ημερομηνίες στο σύστημα, παρακαλώ περιμένετε.',
}

// VAD / timing
const FRAME_BYTES   = 160
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff)   // 0xFF = µ-law silence
// End-of-turn silence before the AI takes its turn. 500ms cut callers off
// mid-thought; 700ms lets them finish while the instant filler keeps it feeling
// responsive. Tunable via AI_SILENCE_MS.
const SILENCE_MS    = parseInt(process.env.AI_SILENCE_MS || '700', 10)
const MIN_SPEECH_MS = 300
// Cap a single utterance so STT stays fast. Tunable via AI_MAX_UTTER_MS.
const MAX_UTTER_MS  = parseInt(process.env.AI_MAX_UTTER_MS || '10000', 10)
const VAD_RMS       = parseInt(process.env.AI_VAD_RMS || '500', 10)
// Barge-in (interrupting the AI WHILE it speaks) needs a louder + SUSTAINED
// voice than normal capture — otherwise the AI's own echo on the phone bridge
// (no AEC) trips it and the AI cuts itself off mid-sentence.
const BARGE_RMS     = parseInt(process.env.AI_BARGE_RMS || '1100', 10)
const BARGE_MIN_MS  = parseInt(process.env.AI_BARGE_MS  || '320', 10)

LOG('providers:', JSON.stringify(providerStatus()))

// ── system-prompt blocks ─────────────────────────────────────────────────────

// Pricing rules. With a live priceContext the AI enumerates real options and
// never quotes a past date. Without it, it still refuses past dates and won't
// invent prices.
const PRICE_ROW_CAP = parseInt(process.env.AI_PRICE_ROW_CAP || '8', 10)

function buildPriceBlock(pc) {
  const today = (pc && pc.today) || new Date().toISOString().slice(0, 10)
  if (pc && Array.isArray(pc.roomTypes) && pc.roomTypes.length) {
    const priceLines = (pc.prices || [])
      .slice(0, PRICE_ROW_CAP)
      .map(p => `- ${p.roomType}/${p.concept}: ${p.from} ${p.currency}'dan (${p.validFrom}→${p.validTo})` +
        (p.converted ? ' [yaklaşık, kur çevrimi]' : ''))
      .join('\n')
    return (
      `\n\nFİYAT LİSTESİ (gece başı "başlayan fiyat"). BUGÜN: ${today}; geçmiş tarihe fiyat verme.` +
      (priceLines ? `\n${priceLines}` : '') +
      `\nSadece bu satırlardaki oda ve rakamları kullan. "[yaklaşık, kur çevrimi]" olanı "yaklaşık" diye sun, kesin tutarı teyit ettir.` +
      `\nKesin fiyat için tarih+kişi tamamlanınca müsaitlik sorgusunu çalıştır.`
    )
  }
  return (
    `\n\nFİYAT: BUGÜN ${today}. Sistemde güncel fiyat tanımlı DEĞİL — fiyat UYDURMA. Tarih ve kişi sayısını al, kesin fiyat için yetkiliye aktar.`
  )
}

// Hotel facts so the AI describes the property from REAL data (hotel record +
// concierge KB + the admin-edited training document), not invention.
// Capped because this block is re-sent every turn and Turkish costs ~1.4 chars
// per token — an unbounded amenity list or training document silently eats the
// daily token budget that pays for actual conversation.
const HOTEL_AMENITY_CAP = parseInt(process.env.AI_HOTEL_AMENITY_CAP || '12', 10)
const HOTEL_KB_CAP = parseInt(process.env.AI_HOTEL_KB_CAP || '6', 10)
const HOTEL_DOC_CHARS = parseInt(process.env.AI_HOTEL_DOC_CHARS || '700', 10)

function buildHotelBlock(h) {
  if (!h) return ''
  const lines = ['\n\nOTEL BİLGİLERİ (oteli SADECE bunlarla anlat, uydurma):']
  if (h.name) {
    const loc = [h.city, h.country].filter(Boolean).join(', ')
    lines.push(`${h.name}${h.stars ? ` (${h.stars} yıldız)` : ''}${loc ? `, ${loc}` : ''}.`)
  }
  if (h.concept)   lines.push(`Konsept: ${h.concept}.`)
  if (h.address)   lines.push(`Adres: ${h.address}.`)
  if (Array.isArray(h.amenities) && h.amenities.length) {
    lines.push(`Olanaklar: ${h.amenities.slice(0, HOTEL_AMENITY_CAP).join(', ')}.`)
  }
  if (Array.isArray(h.kb) && h.kb.length) {
    for (const e of h.kb.slice(0, HOTEL_KB_CAP)) lines.push(`- ${e.q ? e.q + ': ' : ''}${e.a}`)
  }
  if (h.trainingDoc && h.trainingDoc.trim()) {
    lines.push(h.trainingDoc.trim().slice(0, HOTEL_DOC_CHARS))
  }
  return lines.join('\n')
}

/**
 * Few-shot block built from REAL call transcripts, retrieved by PPG for the
 * intent the router detected. This is the "few-shot RAG instead of fine-tune"
 * strategy: the hotel's own best calls are the training signal, injected per
 * turn instead of baked into weights, so improving the agent is a matter of
 * marking good calls in the panel — no retraining, no model hosting.
 */
const FEWSHOT_CAP = parseInt(process.env.AI_FEWSHOT_CAP || '3', 10)

function buildFewShotBlock(pack) {
  if (!Array.isArray(pack) || !pack.length) return ''
  const lines = ['\n\nGERÇEK ÇAĞRI ÖRNEKLERİ (üslubu örnek al, kelimesi kelimesine okuma):']
  for (const ex of pack.slice(0, FEWSHOT_CAP)) {
    if (!ex || !ex.user || !ex.assistant) continue
    lines.push(`M: "${String(ex.user).slice(0, 160)}"`)
    lines.push(`A: "${String(ex.assistant).slice(0, 200)}"`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

// ── one live AI call ─────────────────────────────────────────────────────────
class AiCall {
  /**
   * @param {object} opts
   * @param {string}  opts.remoteIp
   * @param {number}  opts.remotePort
   * @param {Function} opts.onBye
   * @param {string}  [opts.greetingOverride]     — per-trunk greeting text
   * @param {string}  [opts.agentName]            — display name of the AI agent
   * @param {Array}   [opts.voiceProfiles]        — [{id,lang,whisperCode,voice,...}]
   * @param {string}  [opts.defaultVoiceProfileId]— which profile to start with
   * @param {object}  [opts.priceContext]         — { today, currency, roomTypes[], concepts[], prices[] }
   * @param {object}  [opts.hotelInfo]            — { name, city, country, stars, concept, website, amenities[], kb[] }
   * @param {string[]}[opts.sttVocabulary]        — hotel jargon/proper nouns for the recogniser
   * @param {object}  [opts.fewShot]              — { <INTENT>: [{user,assistant}], default: [...] }
   * @param {Function}[opts.onTool]               — async (toolCall) => result  (availability lookups)
   */
  constructor({
    remoteIp, remotePort, onBye, greetingOverride, agentName, defaultAgentName,
    voiceProfiles, defaultVoiceProfileId,
    priceContext, hotelInfo, sttVocabulary, fewShot, hotelId, callId, caller, onEnd, onAction, onTool,
  } = {}) {
    this.remoteIp   = remoteIp
    this.remotePort = remotePort
    this.onBye      = onBye
    // Call metadata for the post-call lead record (name/phone capture).
    this.hotelId    = hotelId || null
    this.callId     = callId || null
    this.caller     = caller || null
    this.onEnd      = onEnd || null
    this.onAction   = onAction || null   // executes [[ACTION {...}]] directives (offer/transfer)
    this.onTool     = onTool || null     // synchronous mid-turn lookups (availability)
    this.startedAt  = Date.now()
    this._reported  = false

    // Resolve voice profiles, then upgrade/override the synthesis voice.
    this.profiles = applyVoiceOverride(
      (Array.isArray(voiceProfiles) && voiceProfiles.length) ? voiceProfiles : BUILTIN_PROFILES,
    )
    const defId = defaultVoiceProfileId || 'female-tr'
    this.currentProfile = this.profiles.find(p => p.id === defId) || this.profiles[0]
    // Lock the operator-selected gender — language auto-switch keeps this gender
    // so a female agent never flips to a male voice mid-call (and vice-versa).
    this.lockedGender = this.currentProfile.gender || (this.currentProfile.id.startsWith('male') ? 'male' : 'female')

    // Agent identity.
    //
    // An operator-configured name is a deliberate choice and is PINNED. A name
    // that merely came from the default profile is not: it must follow the
    // caller's language, otherwise the agent switches to a German voice and
    // still introduces itself as "Elif". Only the derived case is re-derived on
    // a language switch — see switchProfileByLang().
    // PPG sends `agentName` ONLY when the hotel configured one, and passes the
    // per-language default separately as `defaultAgentName` — collapsing the
    // two would make every call look pinned and freeze the name in one language.
    this._agentNamePinned = !!(agentName && String(agentName).trim())
    this.agentName = this._agentNamePinned
      ? String(agentName).trim()
      : (defaultAgentName || profileAgentName(this.currentProfile))
    const hotel = HOTEL === 'otelimiz' ? 'otelimiz' : HOTEL
    this.hotelName = (hotelInfo && hotelInfo.name) || hotel

    // Greeting
    this._greeting = greetingOverride ||
      `${hotel} çağrı merkezine hoş geldiniz, ben ${this.agentName}. Size nasıl yardımcı olabilirim?`

    // Live data blocks injected from PPG.
    this._priceBlock = buildPriceBlock(priceContext)
    this._hotelBlock = buildHotelBlock(hotelInfo)
    this._fewShot    = fewShot && typeof fewShot === 'object' ? fewShot : null
    // Hotel jargon + proper nouns handed to every STT provider (Deepgram
    // keywords / Whisper prompt biasing) so "Swim-up", "UAI" and room names
    // stop coming back as nonsense.
    this.sttVocabulary = buildVocabulary(sttVocabulary)

    // Router state
    this.intent = null            // last classified intent
    this.intentConfidence = 0
    this.intentSummary = ''
    this.escalationHits = 0       // COMPLAINT_URGENT turns — 2 in a row = hand off
    this.noUnderstandStreak = 0   // 2 failed turns = hand off (persona red line)

    this.systemPrompt = this.buildSystemPrompt()

    // Filler ("buying time") phrases — pre-synthesized so the AI acknowledges
    // instantly the moment the caller stops talking, covering STT+LLM latency.
    this.fillerCache = new Map()  // voiceName → Map(text → ulawBuffer)

    this.seq  = (Math.random() * 0xffff) | 0
    this.ts   = (Math.random() * 0xffffffff) >>> 0
    this.ssrc = (Math.random() * 0xffffffff) >>> 0
    this.playQueue  = []
    this.speaking   = false
    this.history    = [{ role: 'system', content: this.systemPrompt }]
    this.utter      = []
    this.inSpeech   = false
    this.speechMs   = 0
    this.silenceMs  = 0
    this.busy       = false
    this.closed     = false
    // STT language: unpinned until the same code comes back twice (see
    // STT_LANG_MODE). `_langSeen` holds the previous detection.
    this._langSeen  = null
    this._langPin   = STT_LANG_MODE === 'pin' ? this.currentProfile.whisperCode : null
    // TTS pipeline: start fetches in parallel, queue audio in sentence order.
    this._sayChain   = Promise.resolve()
    this._pendingTts = 0
    this.bargeMs     = 0   // consecutive loud-input ms while AI speaks (barge-in)

    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (m) => this.onRtp(m))
    this.sock.on('error', (e) => LOG('rtp sock err', e.message))
    this.sock.bind(AI_RTP_PORT, '0.0.0.0', () =>
      LOG(`RTP bound :${AI_RTP_PORT} peer=${remoteIp}:${remotePort} profile=${this.currentProfile.id}`))

    this.pacer = setInterval(() => this.tick(), 20)
    // Greeting: wait ~900ms for the PBX/rtpengine media path to settle, then
    // push ~300ms of lead-in silence so the first syllable isn't clipped.
    setTimeout(() => {
      if (this.closed) return
      for (let i = 0; i < 15; i++) this.playQueue.push(SILENCE_FRAME)
      this.speaking = true
      this.say(this._greeting)
    }, 900)
    // Warm one filler for the starting voice so the first turn is instant.
    this.prewarmFiller()
  }

  /**
   * Compose the full system prompt. Called at construction and again whenever
   * the router changes the detected intent, so the few-shot pack and the
   * intent steer always match what the caller is actually asking about.
   */
  buildSystemPrompt() {
    // BREVITY IS A HARD REQUIREMENT, not tidiness. The whole prompt is re-sent
    // on EVERY turn, and Groq's real ceiling is tokens-per-day: at 8.5k chars
    // (~6.1k tokens) the 100k TPD budget bought about SIXTEEN turns a day, and
    // the 8B fallback rejected the request outright (413, its entire per-minute
    // budget is 6k tokens). Turkish costs roughly 1.4 chars per token, so every
    // sentence removed here is real call capacity. Say each rule once, tersely.
    const basePrompt = process.env.AI_SYSTEM_PROMPT ||
      `${this.hotelName} otelinin çağrı merkezi asistanı ${this.agentName}'sın. Telefondasın. Rezervasyon alır, soruları yanıtlar, gerekirse insana aktarırsın. Sorulursa yapay zeka olduğunu söylersin.` +

      `\n\nDİL: Arayan hangi dilde konuşuyorsa o dilde yanıtla. "Siz" diliyle hitap et; ad öğrenince "Ahmet Bey/Ayşe Hanım". Tek dilde, dilbilgisi doğru, temiz yaz; başka dilden kelime karıştırma.` +

      // Voice-channel rules: text-tuned models write lists and paragraphs, which
      // are unlistenable on a phone line. The test call answered in 4-5
      // sentences and stacked two questions.
      `\n\nSESLİ KANAL KURALLARI:` +
      `\n1) EN FAZLA 2 CÜMLE. Kesin sınır. Liste okuma, oda tiplerini arka arkaya sayma. En fazla iki seçenek söyle, sonra "devam edeyim mi?" diye sor.` +
      // "Always end with a question" fought "never ask twice" and the question
      // rule won: the agent re-asked for dates one turn after asking for them.
      // Waiting is allowed — a caller who was just asked something does not
      // need to be asked again.
      `\n2) Yanıtın sonunda EN FAZLA tek soru sor, sonra SUS. Zaten cevabını beklediğin bir soru varsa YENİ SORU SORMA — sadece misafirin sorusunu yanıtla ve bekle. Tarih ile kişi sayısını AYRI turlarda öğren.` +
      // Do NOT ask the model to spell numbers out. Measured: asked to speak
      // 25.900 it produced "iki beş bin doksan yüz TL" — gibberish, and it is
      // MONEY. The TTS engine reads Turkish numerals correctly on its own, so
      // the model's job is to copy the digits exactly and nothing more.
      `\n3) Fiyatı listedeki RAKAMLA yaz ("25.900 TL"). Rakamı kelimeye ÇEVİRME, yuvarlama, değiştirme — okumayı sistem yapar.` +
      `\n4) Misafir soru sorarsa önce ona cevap ver. Kendini tekrarlama.` +
      // The same closing question three turns running is what a caller hears as
      // a robot. Measured on three consecutive answers: all ended "Başka bir
      // hizmet hakkında bilgi almak ister misiniz?".
      // Measured: three turns running ended by asking for dates + guest count,
      // each time in different words. String-different, meaning-identical — and
      // to a caller that is the same robot asking the same thing three times.
      `\n5) AYNI BİLGİYİ İKİ KEZ İSTEME. Tarih/kişi sayısını bir kez sorduysan, misafir vermeden TEKRAR SORMA — farklı kelimelerle de sorma. Misafir başka bir şey soruyorsa sadece onu yanıtla ve sus; bilgi eksikse bir sonraki turda tamamlarsın.` +
      // Measured again after the first fix: two of three turns still closed with
      // the identical stock line "Başka bir konuda yardımcı olabilir miyim?".
      `\n6) "Başka bir konuda yardımcı olabilir miyim?" gibi GENEL kapanış kalıbını kullanma. Kapanış sorun konuşulan konuya ÖZEL olsun (çocuk kulübü konuşuluyorsa çocukların yaşı, plaj konuşuluyorsa hangi tarihler gibi) ve bir önceki turda sorduğunu tekrarlama.` +

      `\n\nTON: Pozitif çerçevele; "yok/hayır" yerine alternatif sun. Şikayet anında önce empati kur, savunmaya geçme.` +

      `\n\nKIRMIZI ÇİZGİLER:` +
      // A live test call quoted 15.500 TL and 17.500 TL for a room the contract
      // does not price. Nothing else matters if the numbers are fiction, so
      // this is stated as an absolute with no room for interpretation.
      `\n- ⛔ FİYAT UYDURMA. Yalnızca FİYAT LİSTESİ'nde yazan ya da müsaitlik sorgusunun döndürdüğü rakamı söyle. Tahmin, yuvarlama, "civarında" YOK.` +
      `\n- ⛔ Listede olmayan oda tipini anlatma, oda adı icat etme.` +
      // Measured: given only "Özel plaj, Çocuk kulübü" it volunteered water
      // slides, playgrounds and supervised beach activities. Facilities are as
      // checkable as prices, and a guest who books for a slide that is not
      // there arrives angry.
      `\n- ⛔ OTEL BİLGİLERİ'nde yazmayan tesis/olanak/hizmet UYDURMA (kaydırak, oyun alanı, restoran sayısı vb.). Yazmıyorsa "bu detayı yetkiliye bağlayayım" de.` +
      `\n- ⛔ Müsaitlik sorgusu çalışmadan "yerimiz var/müsaitiz/ayırtabiliriz" DEME.` +
      `\n- Fiyat sorulunca önce tarih + kişi sayısı + çocuk yaşını tamamla, sonra sorguyu çalıştır.` +
      `\n- Kart numarası/CVV ASLA isteme; ödeme sadece güvenli link ile.` +
      `\n- Resepsiyon inisiyatifindeki konulara (erken giriş vb.) kesin söz verme; "not alıyorum, müsaitliğe göre" de.` +
      `\n- Rezervasyonu kesinleştirmeden önce tarih, kişi ve toplam tutarı özetleyip sesli onay al.` +
      `\n- Bilmediğini uydurma; yetkiliye aktar.` +

      `\n\nAKIŞ: karşıla → niyeti anla → tarih ve kişi sayısını al → müsaitlik sorgusunu çalıştır → sonucu sun → uygunsa daha iyi oda öner → özetle, ödeme linkini ilet, kapat.` +

      `\n\nİNSANA AKTAR: misafir sinirliyse/insan isterse; düğün, toplantı, 5+ oda; üst üste 2 kez anlamazsan; sisteme ulaşılamazsa.`

    // Machine channel: tools + actions. Never read aloud.
    const actionBlock =
      `\n\nSİSTEM AKSİYONLARI (sesli okunmaz; cevabının EN SONUNA tek satır, misafire bundan bahsetme):` +
      `\n• Müsaitlik+kesin fiyat (tarih ve kişi tamamlanınca, fiyat vermeden ÖNCE): [[ACTION {"type":"check_availability","checkIn":"YYYY-AA-GG","checkOut":"YYYY-AA-GG","adults":N,"children":N,"childAges":[]}]] — sonucu sistem verir, fiyatı ONDAN SONRA söyle. Önce "hemen kontrol ediyorum" de.` +
      `\n• Ödeme linki: [[ACTION {"type":"send_offer","channel":"email|whatsapp","guestName":"","guestEmail":"","guestPhone":"","room":"","total":N,"currency":"TRY|EUR","checkIn":"","checkOut":"","adults":N}]] — total'ı verdiğin fiyattan al, uydurma. E-posta yoksa whatsapp.` +
      `\n• Aktarım: [[ACTION {"type":"transfer","department":"reception|sales|reservation|manager"}]] — grup/düğün→sales, mevcut rezervasyon→reservation, öfke/insan talebi→reception.` +
      `\nBir turda en fazla bir aksiyon.`

    // Style rails.
    //
    // There used to be a long "[Fiyat sunma] '… oda tipimiz, … konseptiyle
    // gecelik … TL'den başlıyor.'"-style phrase book here, labelled "inspiration
    // only". A live test call proved that framing does not survive contact with
    // a model: it read the lines VERBATIM ("Bu tarihlerde müsaitliğimiz var,
    // hemen ayırtabiliriz.") and FILLED IN THE BLANKS WITH INVENTED NUMBERS.
    // Templates with holes are an invitation to hallucinate, and reciting them
    // is what made the agent sound robotic. No quotable sentences here at all —
    // tone is behaviour, phrasing comes from the real-call few-shot pack.
    const playbookBlock =
      `\n\nNASIL KONUŞMALISIN:` +
      `\n- Sıcak ve insani ol; söylediğine gerçekten tepki ver, duygusuz bilgi aktarma.` +
      `\n- Kendi cümlelerini kur, ezber kalıp okuma. Aynı şeyi tekrar söylemen gerekirse başka kelimelerle söyle.` +
      `\n- Bu konuşmada kullandığın onay kelimelerini ("Tabii", "Anladım", "Elbette") tekrar kullanma; çoğu zaman hiç kullanma, doğrudan konuya gir.` +
      `\n- Konuşma dili kullan. Madde işareti, liste, başlık, emoji YOK.`

    // Real-call examples for THIS intent (falls back to the generic pack).
    const pack = this._fewShot
      ? (this._fewShot[this.intent] || this._fewShot.default || null)
      : null

    return basePrompt + this._priceBlock + this._hotelBlock + playbookBlock +
      buildFewShotBlock(pack) + intentDirective(this.intent ? { intent: this.intent } : null) + actionBlock
  }

  /** Swap in the intent-specific prompt when the router's verdict changes. */
  applyIntent(result) {
    if (!result || !result.intent) return
    this.intentConfidence = result.confidence
    this.intentSummary = result.summary_key || this.intentSummary
    if (result.intent === this.intent) return
    this.intent = result.intent
    this.systemPrompt = this.buildSystemPrompt()
    if (this.history[0] && this.history[0].role === 'system') this.history[0].content = this.systemPrompt
    LOG(`intent → ${result.intent} (${result.confidence.toFixed(2)}, ${result.source})`)
  }

  /**
   * Pre-synthesize ALL fillers for the current voice so playFiller() can push
   * synchronously from cache (no await → no reordering vs the streamed reply).
   * Non-blocking; safe to call again after a language/voice switch.
   */
  async prewarmFiller() {
    const { whisperCode } = this.currentProfile
    const list = [...(FILLERS[whisperCode] || FILLERS.tr), LOOKUP_FILLERS[whisperCode] || LOOKUP_FILLERS.tr]
    const voice = this.currentProfile.voice
    let cache = this.fillerCache.get(voice)
    if (!cache) { cache = new Map(); this.fillerCache.set(voice, cache) }
    for (const text of list) {
      if (cache.has(text)) continue
      try { cache.set(text, await synthesize(text, this.currentProfile)) } catch (e) { LOG('filler prewarm err', e.message) }
    }
  }

  /** Push a pre-warmed clip immediately; warm it in the background on a miss. */
  _pushCached(text) {
    const cache = this.fillerCache.get(this.currentProfile.voice)
    const ulaw = cache && cache.get(text)
    if (ulaw) {
      if (this.closed || this.cancelResponse) return
      this._enqueue(ulaw)
      this.speaking = true
    } else {
      this.prewarmFiller().catch(() => {})
    }
  }

  /** Short "buying time" acknowledgement while STT+LLM run. */
  playFiller() {
    const list = FILLERS[this.currentProfile.whisperCode] || FILLERS.tr
    // Random pick, never the same as last time → no repetition.
    let idx = Math.floor(Math.random() * list.length)
    if (list.length > 1 && idx === this._lastFiller) idx = (idx + 1) % list.length
    this._lastFiller = idx
    this._pushCached(list[idx])
  }

  /** Longer "querying the system" line — only for real tool lookups. */
  playLookupFiller() {
    this._pushCached(LOOKUP_FILLERS[this.currentProfile.whisperCode] || LOOKUP_FILLERS.tr)
  }

  /**
   * Switch to the detected language but KEEP the locked gender. Prefer a
   * profile matching (language + lockedGender); only if none exists fall back
   * to any profile for that language. This stops a female agent flipping to a
   * male voice when the caller speaks another language.
   */
  switchProfileByLang(detectedLang) {
    if (!detectedLang) return
    const sameGender = this.profiles.find(p => p.whisperCode === detectedLang && p.gender === this.lockedGender)
    const anyLang    = this.profiles.find(p => p.whisperCode === detectedLang)
    const match = sameGender || anyLang
    if (match && match.id !== this.currentProfile.id) {
      LOG(`lang switch: ${this.currentProfile.id} → ${match.id} (stt=${detectedLang}, gender=${this.lockedGender})`)
      this.currentProfile = match
      // The persona is the voice AND the name. Leaving a Turkish name on a
      // German voice is what made the agent say "mein Name ist Elif".
      if (!this._agentNamePinned) {
        const newName = profileAgentName(match)
        if (newName !== this.agentName) {
          LOG(`agent name: ${this.agentName} → ${newName}`)
          this.agentName = newName
          // The name is baked into the system prompt, so it has to be rebuilt.
          this.systemPrompt = this.buildSystemPrompt()
          if (this.history[0] && this.history[0].role === 'system') this.history[0].content = this.systemPrompt
        }
      }
      this.prewarmFiller().catch(() => {})  // warm fillers for the new language
    }
  }

  /** Track detections and pin the STT language once it is stable (adaptive mode). */
  updateLangPin(detected) {
    if (STT_LANG_MODE !== 'adaptive' || !detected) return
    if (this._langSeen === detected && this._langPin !== detected) {
      this._langPin = detected
      LOG(`stt language pinned to "${detected}" after two consistent turns`)
    } else if (this._langSeen !== detected) {
      // A new language means the caller switched — unpin and re-observe.
      if (this._langPin && this._langPin !== detected) {
        LOG(`stt language unpinned (was ${this._langPin}, heard ${detected})`)
        this._langPin = null
      }
    }
    this._langSeen = detected
  }

  onRtp(msg) {
    if (msg.length < 12) return
    const payload = msg.subarray(12)
    let sum = 0
    for (let i = 0; i < payload.length; i++) { const s = ulawByteToPcm(payload[i]); sum += s * s }
    const rms = Math.sqrt(sum / Math.max(1, payload.length))

    // ── While the AI is talking OR thinking: HALF-DUPLEX guard ──
    // The phone bridge has no echo cancellation, so the AI's own voice (and the
    // filler) loops back as "input". While speaking/fetching/processing, only a
    // LOUDER, SUSTAINED voice counts as a real barge-in.
    if (this.speaking || this._pendingTts > 0 || this.busy) {
      if (this.speaking && rms > BARGE_RMS) {
        this.bargeMs += 20
        if (this.bargeMs >= BARGE_MIN_MS) {
          this.playQueue.length = 0
          this.speaking = false
          this.cancelResponse = true
          this._pendingTts = 0
          this._sayChain = Promise.resolve()  // abandon in-flight chain items
          // Barge-ins are a MEASURED quality signal (the caller had to talk
          // over the agent). The post-call engine uses this count instead of
          // guessing interruptions from the text transcript.
          this.bargeCount = (this.bargeCount || 0) + 1
          // Start capturing the caller's interrupting utterance from here.
          this.bargeMs = 0
          this.inSpeech = true
          this.silenceMs = 0
          this.speechMs = BARGE_MIN_MS
          this.utter = [Buffer.from(payload)]
        }
      } else {
        this.bargeMs = 0  // must be continuous to count as barge-in
      }
      return  // don't let echo leak into the normal capture path
    }
    this.bargeMs = 0

    // ── AI silent: normal capture VAD ──
    const voiced = rms > VAD_RMS
    if (voiced) {
      this.inSpeech = true
      this.silenceMs = 0
      this.speechMs += 20
      this.utter.push(Buffer.from(payload))
      if (this.speechMs >= MAX_UTTER_MS) this.endTurn()
    } else if (this.inSpeech) {
      this.silenceMs += 20
      this.utter.push(Buffer.from(payload))
      if (this.silenceMs >= SILENCE_MS) this.endTurn()
    }
  }

  async endTurn() {
    if (!this.inSpeech || this.busy) return
    const ms = this.speechMs
    const audio = Buffer.concat(this.utter)
    this.inSpeech = false; this.speechMs = 0; this.silenceMs = 0; this.utter = []
    if (ms < MIN_SPEECH_MS) return
    this.busy = true; this.cancelResponse = false
    // Occasional, varied acknowledgement while STT+LLM run. STT is fast (~0.4s)
    // so fire RARELY (~30% of longer turns) and never the same phrase twice.
    if (ms >= 1200 && Math.random() < 0.3) this.playFiller()
    try {
      const { text, language, provider } = await transcribe(audio, {
        language: this._langPin || undefined,
        vocabulary: this.sttVocabulary,
      })
      LOG('STT:', JSON.stringify(text), 'lang:', language, 'via:', provider)
      if (this.closed) { this.busy = false; return }
      if (!text) {
        // Empty transcript on a SHORT burst is noise (a cough, line crackle) —
        // stay silent, as answering "anlayamadım" to every stray sound is the
        // behaviour callers complained about. On a LONG burst the caller really
        // did speak and we failed, so it counts toward the hand-off rule.
        if (ms >= 1000) await this.failedTurn()
        this.busy = false
        return
      }
      this.updateLangPin(language)
      // Switch voice to match caller's language (gender preserved)
      this.switchProfileByLang(language)

      // Layer 1: intent routing. On the FIRST caller turn we wait for it (a
      // few hundred ms under the filler) because that is when the few-shot
      // pack and the escalation steer change the whole call. Later turns
      // classify in the background so they never add latency.
      const recent = this.history.filter(m => m.role === 'user').map(m => m.content)
      if (!this.intent) {
        const r = await classifyIntent(text, recent).catch(() => null)
        this.applyIntent(r)
        this.noteEscalation(r)
      } else {
        classifyIntent(text, recent)
          .then(r => { this.applyIntent(r); this.noteEscalation(r) })
          .catch(() => {})
      }

      this.history.push({ role: 'user', content: text })

      // Layer 2: the live conversation. Stream the reply so TTS + playback of
      // sentence 1 begin while the model is still generating sentence 2.
      const reply = await this.runLlmTurn()
      LOG('LLM:', JSON.stringify(reply))
      if (this.closed) { this.busy = false; return }

      if (reply) {
        this.noUnderstandStreak = 0
        // Offer/transfer directives fire immediately; a check_availability is
        // answered IN-LINE — run the lookup, feed the result back and let the
        // model speak the real numbers in a second pass.
        this.runActions(reply)
        await this.handleToolCalls(reply)
      } else if (!this.cancelResponse) {
        await this.failedTurn()
      }
    } catch (e) {
      LOG('turn error:', e.message)
      try { await this.say('Bir sorun oluştu, lütfen tekrar söyler misiniz?') } catch {}
    }
    this.busy = false
  }

  /**
   * A turn we could not understand — empty transcript or empty completion.
   * The persona's red line is explicit: after TWO in a row, stop asking the
   * caller to repeat themselves and get a human on the line. Endlessly
   * replying "anlayamadım" is the failure mode callers actually complained
   * about.
   */
  async failedTurn() {
    if (this.cancelResponse || this.closed) return
    this.noUnderstandStreak++
    if (this.noUnderstandStreak >= 2 && this.onAction) {
      await this.say('Sizi daha iyi anlayabilmesi için hemen bir arkadaşıma aktarıyorum, lütfen hatta kalın.')
      this.dispatchAction({ type: 'transfer', department: 'reception', reason: 'not-understood-twice' })
    } else {
      await this.say('Anlayamadım, tekrar eder misiniz?')
    }
  }

  /**
   * Keep the prompt from growing without bound.
   *
   * Every turn re-sends the whole conversation, and Groq's binding limit is
   * TOKENS PER MINUTE (measured: ~12k on the 70B). With a ~2.5k-token system
   * prompt, an unbounded history reaches the limit within one long call and the
   * turn starts 429ing mid-conversation.
   *
   * Caller turns are kept in full — they carry the facts of the booking (name,
   * dates, pax) and are short. Only older ASSISTANT turns are dropped, because
   * they are the bulk of the tokens and their content is already reflected in
   * what the caller says next.
   */
  trimHistory() {
    const MAX_MESSAGES = parseInt(process.env.AI_HISTORY_MAX || '24', 10)
    if (this.history.length <= MAX_MESSAGES + 1) return
    const system = this.history[0]
    const rest = this.history.slice(1)
    const keep = []
    let assistantBudget = Math.floor(MAX_MESSAGES / 2)
    // Walk backwards so the most recent context always survives.
    for (let i = rest.length - 1; i >= 0; i--) {
      const m = rest[i]
      if (m.role === 'assistant') {
        if (assistantBudget <= 0) continue
        assistantBudget--
      }
      keep.unshift(m)
      if (keep.length >= MAX_MESSAGES) break
    }
    const dropped = this.history.length - (keep.length + 1)
    if (dropped > 0) LOG(`history trimmed: dropped ${dropped} older message(s)`)
    this.history = [system, ...keep]
  }

  /** Stream one LLM turn into speech; returns the RAW reply (actions included). */
  async runLlmTurn() {
    this.trimHistory()
    const stop = () => this.closed || this.cancelResponse
    // Speak each sentence but NEVER read an [[ACTION ...]] directive aloud —
    // strip from the first "[[" onward (directives are emitted last).
    const speakClean = (sentence) => {
      const spoken = sentence.includes('[[') ? sentence.slice(0, sentence.indexOf('[[')).trim() : sentence
      if (spoken) this.say(spoken)
    }
    const reply = await chatStream(this.history, speakClean, stop)
    if (reply) {
      const clean = reply.replace(/\[\[ACTION[\s\S]*?\]\]/g, '').trim()
      this.history.push({ role: 'assistant', content: clean || reply })
    }
    return reply
  }

  /** Count consecutive escalation signals; two in a row hands the call over. */
  noteEscalation(result) {
    if (!result) return
    if (result.intent === 'COMPLAINT_URGENT' && result.confidence >= 0.7) this.escalationHits++
    else this.escalationHits = 0
  }

  /** Parse every [[ACTION {json}]] directive out of a raw reply. */
  parseActions(rawReply) {
    const out = []
    const re = /\[\[ACTION\s*(\{[\s\S]*?\})\s*\]\]/g
    let m
    while ((m = re.exec(rawReply)) !== null) {
      try { out.push(JSON.parse(m[1])) } catch { LOG('bad action json:', m[1]) }
    }
    return out
  }

  /**
   * check_availability is a REAL tool, not a fire-and-forget notification: the
   * caller is waiting for the answer. Run the lookup, push the result into the
   * conversation as a system observation, then let the model speak it. Capped
   * at one lookup per turn so a confused model can't loop the caller.
   *
   * @returns {Promise<boolean>} true when the turn was handled here.
   */
  async handleToolCalls(rawReply) {
    const call = this.parseActions(rawReply).find(a => a && a.type === 'check_availability')
    if (!call || !this.onTool || this._toolInFlight) return false
    this._toolInFlight = true
    this.playLookupFiller()
    let result = null
    try {
      result = await this.onTool({
        ...call,
        hotelId: this.hotelId,
        callId: this.callId,
        caller: this.caller,
      })
    } catch (e) {
      LOG('tool check_availability failed:', e.message)
    }
    this._toolInFlight = false
    if (this.closed || this.cancelResponse) return true

    // The contract behind this tool publishes prices and stop-sale but not
    // always room COUNTS. When it doesn't (stockDataAvailable=false) the agent
    // may quote the rate but must NOT promise a room — "empty" is not "zero",
    // and a guaranteed booking the hotel can't honour is worse than a callback.
    const stockUnknown = result && result.dataAvailable && result.stockDataAvailable === false
    this.history.push({
      role: 'system',
      content: result
        ? `MÜSAİTLİK SORGU SONUCU (sistemden geldi, GERÇEK veri — sadece bunu kullan):\n${JSON.stringify(result)}\n` +
          `Bu sonucu misafire 1-2 cümleyle, sesli okunacak biçimde aktar. Fiyatı UYDURMA; sonuçta yoksa kesin fiyat verme.` +
          (stockUnknown
            ? ` DİKKAT: oda ADEDİ bilgisi yok. Fiyatı söyleyebilirsin ama "kesin yeriniz var / ayırdım" DEME; "fiyatımız şu, uygunsa hemen teyit ettirelim" gibi kur.`
            : ` Boş oda yoksa pozitif çerçeveleyip alternatif tarih öner.`)
        : `MÜSAİTLİK SORGUSU BAŞARISIZ: sisteme ulaşılamadı. Misafire fiyat/müsaitlik UYDURMA; kısa bir özür ile bir yetkiliye aktaracağını söyle ve transfer aksiyonunu çalıştır.`,
    })

    const followUp = await this.runLlmTurn()
    LOG('LLM(tool):', JSON.stringify(followUp))
    if (followUp) this.runActions(followUp)
    else if (!result) this.dispatchAction({ type: 'transfer', department: 'reservation', reason: 'availability-lookup-failed' })
    return true
  }

  /** Dispatch the non-tool directives (offer, transfer) to PPG. */
  runActions(rawReply) {
    if (!this.onAction) return
    for (const action of this.parseActions(rawReply)) {
      if (action.type === 'check_availability') continue   // handled in-line
      this.dispatchAction(action)
    }
    // Router-driven safety net: two consecutive escalation turns hand off even
    // if the model never emitted the directive itself.
    if (this.escalationHits >= 2 && !this._escalated) {
      this._escalated = true
      LOG('router escalation: 2 consecutive COMPLAINT_URGENT turns → handing off')
      this.dispatchAction({ type: 'transfer', department: 'manager', reason: 'router-escalation' })
    }
  }

  dispatchAction(action) {
    if (!this.onAction) return
    LOG('ACTION:', JSON.stringify(action))
    try {
      this.onAction({
        ...action,
        hotelId: this.hotelId,
        callId: this.callId,
        caller: this.caller,
        intent: this.intent,
        language: this._langPin || this._langSeen || this.currentProfile.whisperCode,
        startedAt: this.startedAt,
        transcript: (this.history || []).filter(t => t.role !== 'system'),
      })
    } catch (e) { LOG('action dispatch err', e.message) }
  }

  // Non-blocking: kicks off TTS fetch immediately (parallel with previous
  // sentences still playing), then chains the queue-push so sentences stay in
  // order. This eliminates the inter-sentence silence gap of sequential fetching.
  say(text) {
    if (this.closed || !text) return
    const profile = this.currentProfile
    this._pendingTts++
    // Start the network fetch RIGHT NOW — before the previous sentence finishes.
    const fetchP = synthesize(text, profile).catch(e => { LOG('tts err', e.message); return null })
    // Queue audio only after previous say() has finished queuing (order preserved).
    this._sayChain = this._sayChain.then(async () => {
      const ulaw = await fetchP
      this._pendingTts--
      if (!ulaw || this.closed || this.cancelResponse) return
      this._enqueue(ulaw)
      this.speaking = true
    })
  }

  /**
   * Queue a µ-law buffer as 20ms frames. The final <160-byte remainder is
   * PADDED with µ-law silence instead of being dropped — dropping it clipped a
   * few ms off every TTS chunk, causing audible clicks between sentences.
   */
  _enqueue(ulaw) {
    let i = 0
    for (; i + FRAME_BYTES <= ulaw.length; i += FRAME_BYTES) this.playQueue.push(ulaw.subarray(i, i + FRAME_BYTES))
    if (i < ulaw.length) {
      const last = Buffer.alloc(FRAME_BYTES, 0xff)  // 0xFF = µ-law silence
      ulaw.copy(last, 0, i)
      this.playQueue.push(last)
    }
  }

  // Drift-correcting pacer: Node timers fire late under load, which left audible
  // gaps between 20ms frames. Each tick sends as many frames as real elapsed
  // time requires (catch-up), so timer jitter no longer becomes audio jitter.
  tick() {
    if (this.closed) return
    const now = Date.now()
    if (!this._nextTs) this._nextTs = now
    let budget = 0
    while (this._nextTs <= now && budget < 12) {
      this._sendFrame()
      this._nextTs += 20
      budget++
    }
    // If we fell badly behind (e.g. long GC pause), resync to avoid a burst storm.
    if (now - this._nextTs > 200) this._nextTs = now
  }

  _sendFrame() {
    let frame = this.playQueue.shift()
    // Only stop speaking when queue is empty AND no TTS fetch is still in flight.
    if (!frame) { if (this.speaking && this._pendingTts === 0) this.speaking = false; frame = SILENCE_FRAME }
    const pkt = Buffer.alloc(12 + frame.length)
    pkt[0] = 0x80; pkt[1] = 0x00
    pkt.writeUInt16BE(this.seq & 0xffff, 2); this.seq = (this.seq + 1) & 0xffff
    pkt.writeUInt32BE(this.ts >>> 0, 4); this.ts = (this.ts + FRAME_BYTES) >>> 0
    pkt.writeUInt32BE(this.ssrc >>> 0, 8)
    frame.copy(pkt, 12)
    this.sock.send(pkt, this.remotePort, this.remoteIp, (e) => { if (e) {} })
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pacer)
    try { this.sock.close() } catch {}
    LOG('call closed')
    // Report the call for lead capture + post-call analysis. Fire-and-forget.
    if (this.onEnd && !this._reported) {
      this._reported = true
      try {
        this.onEnd({
          hotelId: this.hotelId,
          callId: this.callId,
          caller: this.caller,
          startedAt: this.startedAt,
          endedAt: Date.now(),
          language: this._langPin || this._langSeen || this.currentProfile.whisperCode,
          // Router output travels with the transcript so the post-call engine
          // starts from the live classification instead of re-deriving it.
          intent: this.intent,
          intentConfidence: this.intentConfidence,
          intentSummary: this.intentSummary,
          // Measured, not inferred — the post-call QA score uses this directly.
          interruptions: this.bargeCount || 0,
          agentName: this.agentName,
          transcript: (this.history || []).filter(m => m.role !== 'system'),
        })
      } catch (e) { LOG('onEnd err', e.message) }
    }
  }
}

module.exports = {
  AiCall, AI_EXT, AI_RTP_PORT, PUBLIC_IP, BUILTIN_PROFILES,
  // Exported so test_conversation.js can assemble the REAL production prompt
  // (price + hotel blocks included) instead of an approximation of it.
  buildPriceBlock, buildHotelBlock,
}
