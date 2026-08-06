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
const BUILTIN_PROFILES = [
  { id: 'female-tr', name: 'Ayşe',   gender: 'female', lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-D' },
  { id: 'male-tr',   name: 'Ahmet',  gender: 'male',   lang: 'tr-TR', whisperCode: 'tr', voice: 'tr-TR-Wavenet-B' },
  { id: 'female-en', name: 'Sophie', gender: 'female', lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-F' },
  { id: 'male-en',   name: 'James',  gender: 'male',   lang: 'en-US', whisperCode: 'en', voice: 'en-US-Wavenet-D' },
  { id: 'female-de', name: 'Greta',  gender: 'female', lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-F' },
  { id: 'male-de',   name: 'Hans',   gender: 'male',   lang: 'de-DE', whisperCode: 'de', voice: 'de-DE-Wavenet-B' },
  { id: 'female-ru', name: 'Наташа', gender: 'female', lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-A' },
  { id: 'male-ru',   name: 'Иван',   gender: 'male',   lang: 'ru-RU', whisperCode: 'ru', voice: 'ru-RU-Wavenet-B' },
  { id: 'female-sv', name: 'Maja',   gender: 'female', lang: 'sv-SE', whisperCode: 'sv', voice: 'sv-SE-Wavenet-A' },
  { id: 'male-sv',   name: 'Erik',   gender: 'male',   lang: 'sv-SE', whisperCode: 'sv', voice: 'sv-SE-Wavenet-B' },
  { id: 'female-fr', name: 'Claire', gender: 'female', lang: 'fr-FR', whisperCode: 'fr', voice: 'fr-FR-Wavenet-A' },
  { id: 'male-fr',   name: 'Pierre', gender: 'male',   lang: 'fr-FR', whisperCode: 'fr', voice: 'fr-FR-Wavenet-B' },
  { id: 'female-ar', name: 'نور',    gender: 'female', lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-A' },
  { id: 'male-ar',   name: 'عمر',    gender: 'male',   lang: 'ar-XA', whisperCode: 'ar', voice: 'ar-XA-Wavenet-B' },
]

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
function buildPriceBlock(pc) {
  const today = (pc && pc.today) || new Date().toISOString().slice(0, 10)
  if (pc && Array.isArray(pc.roomTypes) && pc.roomTypes.length) {
    const priceLines = (pc.prices || [])
      .map(p => `  - ${p.roomType} / ${p.concept}: ${p.from} ${p.currency}'dan başlayan gece fiyatı (geçerli: ${p.validFrom} → ${p.validTo})`)
      .join('\n')
    return (
      `\n\n=== FİYAT & ODA BİLGİSİ ===` +
      `\nBUGÜNÜN TARİHİ: ${today}. Bu tarihten ÖNCEKİ hiçbir tarih için fiyat verme.` +
      `\nODA TİPLERİ: ${pc.roomTypes.join(', ')}.` +
      `\nKONSEPTLER: ${pc.concepts.join(', ')}.` +
      (priceLines ? `\nGÜNCEL FİYAT LİSTESİ (gece başı):\n${priceLines}` : '') +
      `\nKURALLAR:` +
      `\n1) Müşteri fiyat sorduğunda mevcut oda tiplerini TEK TEK say ve her birinin konseptini (pansiyon) belirt.` +
      `\n2) Fiyat vermeden önce giriş ve çıkış tarihini, yetişkin sayısını ve çocuk YAŞLARINI öğren.` +
      `\n3) Geçmiş bir tarih istenirse fiyat verme; "geçmiş tarih için fiyat veremiyorum, güncel tarihlerde yardımcı olayım" de.` +
      `\n4) Listede olmayan oda/tarih için fiyat UYDURMA; bir yetkiliye aktarmayı öner.` +
      `\n5) Yukarıdaki liste "başlayan fiyat"tır. Tarih + kişi bilgisi tamamlandığında KESİN fiyat için müsaitlik sorgusunu çalıştır.`
    )
  }
  return (
    `\n\n=== FİYAT KURALI ===` +
    `\nBUGÜNÜN TARİHİ: ${today}. Geçmiş tarih için fiyat verme.` +
    ` Sistemde güncel fiyat tanımlı değil; fiyat UYDURMA. Giriş-çıkış tarihi ile kişi sayısını al, oda tiplerini tek tek say ve kesin fiyat için bir yetkiliye aktarmayı öner.`
  )
}

// Hotel facts so the AI describes the property from REAL data (hotel record +
// concierge KB + the admin-edited training document), not invention.
function buildHotelBlock(h) {
  if (!h) return ''
  const lines = ['\n\n=== OTEL BİLGİLERİ (oteli SADECE bunlarla anlat, uydurma) ===']
  if (h.name) {
    const loc = [h.city, h.country].filter(Boolean).join(', ')
    lines.push(`Otel: ${h.name}${h.stars ? ` (${h.stars} yıldız)` : ''}${loc ? `, ${loc}` : ''}.`)
  }
  if (h.concept)   lines.push(`Konsept: ${h.concept}.`)
  if (h.address)   lines.push(`Adres: ${h.address}.`)
  if (h.website)   lines.push(`Web sitesi: ${h.website}.`)
  if (Array.isArray(h.amenities) && h.amenities.length) lines.push(`Olanaklar: ${h.amenities.join(', ')}.`)
  if (Array.isArray(h.kb) && h.kb.length) {
    lines.push('Doğrulanmış bilgiler (sık sorulanlar):')
    for (const e of h.kb) lines.push(`- ${e.q ? e.q + ': ' : ''}${e.a}`)
  }
  if (h.trainingDoc && h.trainingDoc.trim()) {
    lines.push('\n--- EĞİTİM DÖKÜMANI (otelin hazırladığı bilgi) ---')
    lines.push(h.trainingDoc.trim())
  }
  lines.push('\nOtel hakkında konuşurken yukarıdaki bilgileri kullan; emin olmadığını uydurma, gerekiyorsa yetkiliye aktarmayı öner.')
  return lines.join('\n')
}

/**
 * Few-shot block built from REAL call transcripts, retrieved by PPG for the
 * intent the router detected. This is the "few-shot RAG instead of fine-tune"
 * strategy: the hotel's own best calls are the training signal, injected per
 * turn instead of baked into weights, so improving the agent is a matter of
 * marking good calls in the panel — no retraining, no model hosting.
 */
function buildFewShotBlock(pack) {
  if (!Array.isArray(pack) || !pack.length) return ''
  const lines = [
    '\n\n=== GERÇEK ÇAĞRILARDAN ÖĞRENİLEN DİYALOG ÖRNEKLERİ ===',
    'Bunlar otelin GERÇEK başarılı görüşmelerinden alınmıştır. Kelimesi kelimesine okuma; ÜSLUBU, sıralamayı ve soru sorma biçimini örnek al.',
  ]
  for (const ex of pack.slice(0, 8)) {
    if (!ex || !ex.user || !ex.assistant) continue
    lines.push(`Misafir: "${String(ex.user).slice(0, 220)}"`)
    lines.push(`Asistan: "${String(ex.assistant).slice(0, 260)}"`)
  }
  return lines.length > 2 ? lines.join('\n') : ''
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
    remoteIp, remotePort, onBye, greetingOverride, agentName, voiceProfiles, defaultVoiceProfileId,
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

    // Resolve voice profiles
    this.profiles = (Array.isArray(voiceProfiles) && voiceProfiles.length)
      ? voiceProfiles : BUILTIN_PROFILES
    const defId = defaultVoiceProfileId || 'female-tr'
    this.currentProfile = this.profiles.find(p => p.id === defId) || this.profiles[0]
    // Lock the operator-selected gender — language auto-switch keeps this gender
    // so a female agent never flips to a male voice mid-call (and vice-versa).
    this.lockedGender = this.currentProfile.gender || (this.currentProfile.id.startsWith('male') ? 'male' : 'female')

    // Agent identity
    this.agentName = agentName || this.currentProfile.name || 'Asistan'
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
    const basePrompt = process.env.AI_SYSTEM_PROMPT ||
      `Sen ${this.hotelName} otelinin resmi, profesyonel, misafirperver ve empatik Yapay Zeka Çağrı Merkezi Asistanı ${this.agentName}'sın. Görevin: rezervasyon talebi almak, sık sorulan soruları yanıtlamak, temel sorunları çözmek ve resepsiyon/satış ekibinin yükünü azaltmak. Robotik ve soğuk konuşmazsın; sorulursa yapay zeka olduğunu saklamazsın.` +

      `\n\nDİL: Arayan hangi dilde konuşuyorsa SEN DE O DİLDE yanıt ver (Türkçe, İngilizce, Almanca, Rusça, Arapça). Her zaman "Siz" diliyle, saygılı hitap et; adını öğrenince "Ahmet Bey / Ayşe Hanım" şeklinde seslen.` +
      `\n\nDİL KALİTESİ (ÇOK ÖNEMLİ): SADECE düzgün, akıcı ve dilbilgisi doğru yanıt yaz. Başka dilden kelime KARIŞTIRMA (Türkçe konuşurken İngilizce kelime kullanma). İmlaya, oda adlarına ve sayılara dikkat et; uydurma/bozuk kelime yazma.` +

      // Voice-channel rules. These exist because text-tuned models write lists
      // and long paragraphs, which are unlistenable on a phone line.
      `\n\n=== SESLİ İLETİŞİM İÇİN OPTİMİZE EDİLMİŞ TEMEL PRENSİPLER ===` +
      `\n1) KISA VE NET OL: Yanıtın EN FAZLA 1-2 cümle olsun. Asla uzun liste okuma, madde madde sayma, tablo tarif etme.` +
      `\n2) SORU-CEVAP DÖNGÜSÜ: Her yanıtının sonunda konuşmayı ilerletecek TEK bir net soru sor, sonra SUS ve cevabı BEKLE. Aynı anda iki soru sorma.` +
      `\n3) DOĞAL DİL: "Efendim", "Memnuniyetle", "Tarihlerinizi kontrol ediyorum" gibi kurumsal ama sıcak ifadeler kullan.` +
      `\n4) RAKAMLAR: Fiyatları ve tarihleri sesli okunacak şekilde yaz — "15.000 TL" değil "on beş bin TL", "2 kişi" değil "iki yetişkin".` +
      `\n5) Misafir kendi sorusunu sorarsa ÖNCE ona cevap ver, kendi sıranı sonra sürdür. Söylediğini tekrarlama.` +

      `\n\nTON: Pozitif çerçevele — "yok / hayır / yapamayız" gibi keskin negatiflerden kaçın. Örn. "o tarihlerde boş oda yok" yerine "belirttiğiniz tarihlerde doluyuz efendim, dilerseniz alternatif tarihlere bakabilirim". Şikayet/sorun anında önce EMPATİ kur ("Bu durumu yaşadığınız için üzgünüm, sizi anlıyorum"), savunmaya geçme.` +

      // Rules distilled from the hotel's own recorded calls.
      `\n\n=== GERÇEK ÇAĞRI TRANSKRİPTLERİNDEN ÖĞRENİLEN KURAL SETİ ===` +
      `\n- Misafir fiyat sorduğunda DOĞRUDAN fiyat verme; önce Tarih + Kişi Sayısı + Çocuk Yaşı bilgilerini tamamla.` +
      `\n- Pazarlık/indirim talebinde: "Tesisimizde dönemsel en uygun dinamik fiyatlar uygulanmaktadır, dilerseniz tarihleriniz için hemen kontrol edeyim." de.` +
      `\n- İptal/iade koşulları sorulduğunda doğrudan iptal garantili paket opsiyonundan bahset.` +
      `\n- Bilgin olmayan konularda uydurma yapma: "Sizi hemen resepsiyon yetkilimize aktarıyorum, lütfen hatta kalın." de ve aktarım aksiyonunu çalıştır.` +

      `\n\nKIRMIZI ÇİZGİLER:` +
      `\n- Bilgi UYDURMA: bilgi bankasında/sistemde olmayan fiyat, kampanya veya özelliği söyleme.` +
      `\n- Kredi kartı numarası veya CVV'yi ASLA sesli isteme. Ödeme yalnızca misafirin telefonuna gönderilen güvenli ödeme linkiyle yapılır.` +
      `\n- Resepsiyon inisiyatifindeki konulara KESİN söz verme (örn. erken giriş): "talebinizi sisteme not alıyorum, giriş günü müsaitliğe göre arkadaşlarımız yardımcı olur" de.` +
      `\n- Rezervasyonu kesinleştirmeden ÖNCE giriş-çıkış tarihi, kişi sayısı ve toplam tutarı özetle ve sesli ONAY al ("Onaylıyor musunuz?").` +

      `\n\nİŞ AKIŞI (her turda tek adım): 1) Karşıla, numara tanınıyorsa isimle hitap et. 2) Niyeti anla. 3) Rezervasyonsa giriş-çıkış tarihi ve yetişkin/çocuk sayısını eksiksiz öğren. 4) Müsaitlik sorgusunu çalıştır, sonucu sun. 5) Fırsat varsa küçük bir farkla daha iyi bir oda öner. 6) Özetle, ödeme linkini ilet ve "Başka yardımcı olabileceğim bir konu var mı?" diyerek kapat.` +

      `\n\nİNSANA AKTARIM: Şu durumlarda inisiyatif alma; "Size daha iyi yardımcı olabilmesi için sizi konunun uzmanı arkadaşıma aktarıyorum, lütfen kısa süre hatta kalın" deyip aktar: misafir sinirli/argo/çok gergin; açıkça "insana/müşteri temsilcisine bağla" derse; düğün, toplantı salonu, 5+ oda grup talebi; üst üste 2 kez anlayamazsan; sisteme ulaşılamayıp anlık fiyat çekilemezse.`

    // Machine channel: tools + actions. Never read aloud.
    const actionBlock =
      `\n\n=== SİSTEM AKSİYONLARI (sesli okunmaz, yalnız sistem için) ===` +
      `\nBir aksiyon gerektiğinde, cevabının EN SONUNA tek satır olarak şu formatta yaz (kullanıcıya bundan bahsetme, normal cümleyle de söyle):` +
      `\n• MÜSAİTLİK + KESİN FİYAT SORGUSU (tarih ve kişi sayısı tamamlanır tamamlanmaz, fiyat vermeden ÖNCE): [[ACTION {"type":"check_availability","checkIn":"<YYYY-AA-GG>","checkOut":"<YYYY-AA-GG>","adults":<sayı>,"children":<sayı>,"childAges":[<yaşlar>]}]]  — sonucu sistem sana verecek, ondan SONRA fiyatı söyle. Sorgu öncesi "hemen kontrol ediyorum" de.` +
      `\n• Ödeme linki gönderme (misafir kabul edip iletişim verince): [[ACTION {"type":"send_offer","channel":"email","guestName":"<ad>","guestEmail":"<e-posta>","guestPhone":"<telefon>","room":"<oda tipi>","total":<sayı>,"currency":"<EUR|TRY>","checkIn":"<YYYY-AA-GG>","checkOut":"<YYYY-AA-GG>","adults":<sayı>}]]  (channel: email | whatsapp; e-posta için email iste, WhatsApp için telefon yeterli)` +
      `\n• İnsana/dahiliyeye aktarma: [[ACTION {"type":"transfer","department":"<reception|sales|reservation|manager>"}]]  — öfke/insan talebi/müdür → manager veya reception; grup, düğün, 5+ oda → sales; mevcut rezervasyon değişikliği → reservation.` +
      `\nKURAL: total ve currency'yi MUTLAKA verdiğin fiyattan al; uydurma. E-posta yoksa channel=whatsapp kullan. Aksiyon satırını yalnız gerçekten gerektiğinde ekle. Bir turda EN FAZLA bir aksiyon yaz.`

    // Style rails so the model improvises instead of reciting.
    const playbookBlock =
      `\n\n=== DOĞAL KONUŞMA İLKELERİ ===` +
      `\n- ASLA aynı kalıbı/aynı kelimeleri tekrarlama. Her cevabı farklı kur. "Anladım", "Tabii" gibi onayları arka arkaya kullanma.` +
      `\n- Kurumsal ama samimi, akıcı ve doğal konuş; ezbere/robotik olma. Aşağıdaki kalıplar SADECE ilham; kelimesi kelimesine okuma.` +
      `\n\n=== DİYALOG KALIPLARI (ilham — çeşitlendir) ===` +
      `\n[Karşılama] "…'a hoş geldiniz, ben ${this.agentName}." / "Bugün size nasıl yardımcı olabilirim?"` +
      `\n[İsim alma] "Öncelikle adınızı öğrenebilir miyim?" / "Size nasıl hitap edeyim?"` +
      `\n[Tarih/kişi öğrenme] "Hangi tarihler için düşünüyorsunuz?" / "Kaç gece ve kaç kişi konaklayacaksınız?" / "Çocuğunuz varsa yaşını alabilir miyim?"` +
      `\n[Fiyat sunma] "… oda tipimiz, … konseptiyle gecelik … TL'den başlıyor." / "Bu tarihler için en uygun seçeneğimiz şu…"` +
      `\n[Oda tipleri] "Standart, Aile, Deluxe ve Suit seçeneklerimiz var; hangisi ilginizi çeker?" / "Deniz manzaralı odalarımız da mevcut."` +
      `\n[Konsept] "Her Şey Dahil konseptimizde tüm öğünler ve seçili içecekler dahildir." / "Ultra Her Şey Dahil'de à la carte restoranlar da kapsamda."` +
      `\n[Konum/ulaşım] "Otelimiz … bölgesinde, plaja sıfır." / "Havaalanı transferi düzenleyebiliyoruz, ister misiniz?"` +
      `\n[Müsaitlik] "Bu tarihlerde müsaitliğimiz var, hemen ayırtabiliriz." / (yoksa) "O tarihler dolu görünüyor; çok yakın bir tarihe alternatif bakayım mı?"` +
      `\n[Ek satış] "Çok küçük bir farkla deniz manzaralı odaya geçebilirsiniz, ister misiniz?" / "Balayı paketimiz de mevcut."` +
      `\n[Teklif/ödeme] "Size özel teklifi telefonunuza ödeme linkiyle gönderebilirim." / "Linkten güvenle ödeyince rezervasyonunuz kesinleşir."` +
      `\n[Teyit] "Özetleyeyim: … tarihleri, … kişi, … oda, toplam … TL. Onaylıyor musunuz?"` +
      `\n[İtiraz/pahalı] "Anlıyorum; daha uygun bir oda tipi ya da farklı tarih önerebilirim." / "Erken rezervasyon avantajımız olabilir, kontrol edeyim."` +
      `\n[Şikayet] "Bu durumu yaşadığınız için üzgünüm, hemen ilgileniyorum." / "Sizi anlıyorum, en kısa sürede çözelim."` +
      `\n[Bilmediğinde] "Bu detayı kesinleştirmem için bir yetkiliye aktarayım."` +
      `\n[Kapanış] "Başka yardımcı olabileceğim bir konu var mı?" / "Sizi otelimizde ağırlamak isteriz."`

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

  /** Stream one LLM turn into speech; returns the RAW reply (actions included). */
  async runLlmTurn() {
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

    this.history.push({
      role: 'system',
      content: result
        ? `MÜSAİTLİK SORGU SONUCU (sistemden geldi, GERÇEK veri — sadece bunu kullan):\n${JSON.stringify(result)}\n` +
          `Bu sonucu misafire 1-2 cümleyle, sesli okunacak biçimde aktar. Boş oda yoksa pozitif çerçeveleyip alternatif tarih öner. Fiyatı UYDURMA; sonuçta yoksa kesin fiyat verme.`
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

module.exports = { AiCall, AI_EXT, AI_RTP_PORT, PUBLIC_IP, BUILTIN_PROFILES }
