// Rastgele ikinci persona (Emre erkek / Elif kadın).  `node test_persona_random.js`
//   - random kapalıyken davranış ESKİSİYLE aynı: operatörün (PPG) adı, profili ve karşılaması kazanır
//   - random açıkken PPG'nin sabitlediği ad/varsayılan profil yok sayılır, ad profile uyar, karşılamadaki ad değişir
//   - kadın persona yalnız Google sesi kullanılabilirken seçilir; oran ayarlanabilir; iki cinsiyet de gerçekten çıkar
const { resolvePersona, BUILTIN_PROFILES, applyVoiceOverride } = require('./ai-agent')

let fails = 0
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }

const profiles = applyVoiceOverride(BUILTIN_PROFILES)
// Canlı PPG yapılandırması (Belconti, 14 Kas 2026)
const ppg = {
  profiles,
  defaultVoiceProfileId: 'female-tr',
  agentName: 'Ayşe',
  defaultAgentName: 'Elif',
  greetingOverride: 'Belconti Resort çağrı merkezine hoş geldiniz, ben Ayşe. Size nasıl yardımcı olabilirim?',
  hotel: 'Belconti Resort',
}

// 1) kapalı: eski davranış
const eski = resolvePersona({ ...ppg, random: false })
check(eski.profile.id === 'female-tr' && eski.agentName === 'Ayşe' && eski.pinned && !eski.randomized, 'random kapalı: PPG\'nin adı (Ayşe) ve profili (female-tr) kazanır')
check(eski.greeting === ppg.greetingOverride, 'random kapalı: PPG karşılaması aynen')
const eski2 = resolvePersona({ profiles, hotel: 'Belconti Resort', random: false })
check(eski2.profile.id === 'male-tr' && eski2.agentName === 'Emre' && !eski2.pinned, 'PPG yapılandırması yoksa varsayılan erkek (Emre)', eski2.greeting)

// 2) açık: erkek
const erkek = resolvePersona({ ...ppg, random: true, rng: () => 0.9, femaleReady: true })
check(erkek.profile.id === 'male-tr' && erkek.agentName === 'Emre' && !erkek.pinned && erkek.randomized, 'random açık (rng 0.9): erkek Emre, ad sabitlenmez')
check(erkek.greeting === 'Belconti Resort çağrı merkezine hoş geldiniz, ben Emre. Size nasıl yardımcı olabilirim?', 'karşılamadaki "Ayşe" → "Emre"', erkek.greeting)

// 3) açık: kadın
const kadin = resolvePersona({ ...ppg, random: true, rng: () => 0.1, femaleReady: true })
check(kadin.profile.id === 'female-tr' && kadin.agentName === 'Elif' && kadin.randomized, 'random açık (rng 0.1): kadın Elif')
check(kadin.greeting === 'Belconti Resort çağrı merkezine hoş geldiniz, ben Elif. Size nasıl yardımcı olabilirim?', 'karşılamadaki "Ayşe" → "Elif"', kadin.greeting)
check(/Chirp3-HD-Achernar$/.test(kadin.profile.voice), 'Elif sesi Chirp3 HD Achernar', kadin.profile.voice)
check(/Chirp3-HD-Puck$/.test(erkek.profile.voice), 'Emre sesi Chirp3 HD Puck', erkek.profile.voice)

// 4) Google kullanılamıyorsa kadın ASLA seçilmez (Piper yedeği erkek sesli)
let kadinCikti = 0
for (let i = 0; i < 200; i++) if (resolvePersona({ ...ppg, random: true, rng: () => 0, femaleReady: false }).profile.id === 'female-tr') kadinCikti++
check(kadinCikti === 0, 'femaleReady=false iken kadın hiç seçilmez')

// 5) gerçek rastgelelik: ikisi de çıkar, oran ~yarı yarıya
let k = 0
for (let i = 0; i < 2000; i++) if (resolvePersona({ ...ppg, random: true, femaleReady: true }).profile.id === 'female-tr') k++
check(k > 850 && k < 1150, 'varsayılan oran ≈ %50', `kadın ${k}/2000`)
let k2 = 0
for (let i = 0; i < 2000; i++) if (resolvePersona({ ...ppg, random: true, femaleReady: true, femaleRatio: 0.2 }).profile.id === 'female-tr') k2++
check(k2 > 280 && k2 < 520, 'oran 0.2 → ≈ %20', `kadın ${k2}/2000`)

// 6) random açık ama profil listesinde iki persona yoksa dokunmaz
const tekli = profiles.filter((p) => p.id !== 'female-tr')
const t = resolvePersona({ ...ppg, profiles: tekli, random: true, femaleReady: true })
check(!t.randomized, 'listede kadın persona yoksa random devreye girmez', t.profile.id)

// 7) karşılama metninde PPG adı yoksa dokunulmaz
const ozel = resolvePersona({ ...ppg, greetingOverride: 'Hoş geldiniz, size nasıl yardımcı olabilirim?', random: true, rng: () => 0.9, femaleReady: true })
check(ozel.greeting === 'Hoş geldiniz, size nasıl yardımcı olabilirim?', 'adsız özel karşılama aynen kalır')

console.log(fails ? `\n${fails} başarısız` : '\nhepsi geçti')
process.exit(fails ? 1 : 0)
