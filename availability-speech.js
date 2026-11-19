// Deterministic spoken answer for a check_availability result.
//
// Why this exists: on a live test call the lookup SUCCEEDED four times
// (rooms + prices came back), but the follow-up LLM turn that was supposed to
// read them out failed/returned "" every time (dead provider chain), so the
// caller never heard a price. The numbers are already structured data — saying
// them must not depend on a language model being up.
//
// Used (a) as the fallback when the post-tool LLM turn is empty, and (b) to
// validate nothing is invented: every figure here comes straight from `result`.

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']

/** '2026-11-24' → '24 Kasım' (empty string when not a valid ISO date). */
function spokenDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) return ''
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month}` : ''
}

const CURRENCY_WORD = { TRY: 'TL', TL: 'TL', EUR: 'euro', USD: 'dolar', GBP: 'sterlin' }
const money = (n, cur) => `${Math.round(n).toLocaleString('tr-TR')} ${CURRENCY_WORD[String(cur || 'TRY').toUpperCase()] || cur}`

/**
 * @param {object|null} result  the /api/cc/availability `result` (or null)
 * @returns {string} what the agent should say; '' only when there is nothing safe to say
 */
function buildAvailabilitySpeech(result) {
  if (!result) return ''
  if (!result.dataAvailable) {
    switch (result.reason) {
      case 'invalid-dates':
      case 'checkout-before-checkin':
      case 'past-date':
        return 'Tarihleri tam anlayamadım; giriş ve çıkış tarihlerini bir kez daha söyler misiniz?'
      case 'stay-too-long':
        return 'Bu kadar uzun konaklamalar için fiyatı satış ekibimiz verecek, sizi onlara aktarıyorum.'
      default:
        return ''
    }
  }

  const stay = [spokenDate(result.checkIn), spokenDate(result.checkOut)]
  const nights = Number(result.nights) || 0
  const pax = `${result.adults} yetişkin${result.children > 0 ? ` ve ${result.children} çocuk` : ''}`
  const head = stay[0] && stay[1]
    ? `${stay[0]} giriş, ${stay[1]} çıkış, ${nights} gece, ${pax} için`
    : `${nights} gece, ${pax} için`

  const rooms = Array.isArray(result.available) ? result.available.filter(r => r && r.totalStay > 0) : []
  if (!result.anyAvailable || rooms.length === 0) {
    return `${head} uygun oda göremedim. Tarihleri biraz kaydırmak ister misiniz?`
  }

  const price = (r) => {
    const approx = r.converted ? 'yaklaşık ' : ''
    const perNight = r.fromPerNight > 0 ? `, gecelik ${approx}${money(r.fromPerNight, r.currency)}` : ''
    return `${r.roomType}${r.concept ? ` ${r.concept} konseptiyle` : ''} toplam ${approx}${money(r.totalStay, r.currency)}${perNight}`
  }
  const [first, second] = rooms
  let text = `${head} ${price(first)}.`
  if (second) text += ` Bir üst seçenek olarak ${price(second)}.`
  text += result.stockDataAvailable === false
    ? ' Kesin oda teyidini rezervasyon ekibimiz yapar; teklifi ödeme linkiyle göndermemi ister misiniz?'
    : ' Teklifi ödeme linkiyle göndermemi ister misiniz?'
  return text
}

module.exports = { spokenDate, buildAvailabilitySpeech }
