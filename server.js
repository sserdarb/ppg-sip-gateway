// ppg-sip-gateway — translates SIP-over-WebSocket to SIP-over-UDP
//
// Single shared UDP socket on a fixed port; sessions identified by the
// branch parameter in our own Via. Lets us run behind Docker port mapping
// (one UDP port for the whole gateway, not random per-session ports).

const http = require('http')
const dgram = require('dgram')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const { RtpEngineClient } = require('./rtpengine-client')

const PORT          = parseInt(process.env.PORT || '8080', 10)
const UDP_PORT      = parseInt(process.env.UDP_PORT || '5070', 10)
const PBX_HOST      = process.env.PBX_HOST || '90.158.44.140'
const PBX_PORT      = parseInt(process.env.PBX_PORT || '5060', 10)
const GATEWAY_HOST  = process.env.GATEWAY_HOST || '76.13.0.113'
const LOG_SIP       = process.env.LOG_SIP === '1'
const RTPENGINE_HOST = process.env.RTPENGINE_HOST || ''   // empty = disabled
const RTPENGINE_PORT = parseInt(process.env.RTPENGINE_PORT || '22222', 10)
const PPG_API_URL    = (process.env.PPG_API_URL || 'https://ppg.pmapartner.com').replace(/\/$/, '')
const AI_DEFAULT_HOTEL = process.env.AI_DEFAULT_HOTEL || '' // slug the 7000 extension represents (prices/offers)
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || ''

/**
 * The hotel's AI config, with the last good copy kept in memory.
 *
 * A live call lost the lookup to a 6s timeout and the agent ran the whole
 * conversation BLIND: no hotelId (so the availability tool and the hand-off
 * both failed with "hotelId required"), no price list, no hotel facts. One slow
 * response should not strip an agent of everything it knows.
 *
 * So: a longer budget, one retry, and a per-hotel cache that survives the
 * failure. Yesterday's prices are far better than none — and when there is no
 * cache either, the caller is at least handled by an agent that knows it has
 * nothing rather than one that invents.
 */
const hotelConfigCache = new Map()   // key → { ai, hotelId, at }
const didRouteCache = new Map()      // DID → { info, at }
const CONFIG_TTL_MS = 30 * 60 * 1000

async function loadHotelConfig(url, cacheKey) {
  for (const timeout of [9000, 6000]) {
    try {
      const r = await apiFetch(url, {
        headers: GATEWAY_SECRET ? { 'x-gateway-secret': GATEWAY_SECRET } : {},
        signal: AbortSignal.timeout(timeout),
      })
      const j = await r.json()
      if (j?.found) {
        const got = { ai: j.ai, hotelId: j.hotelId, at: Date.now() }
        hotelConfigCache.set(cacheKey, got)
        return got
      }
      console.warn(`[ai] config lookup returned found=false for ${cacheKey}`)
      break
    } catch (e) {
      console.error(`[ai] config fetch failed (${timeout}ms): ${e.message}`)
    }
  }
  const cached = hotelConfigCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) {
    console.warn(`[ai] using cached config for ${cacheKey} (${Math.round((Date.now() - cached.at) / 1000)}s old)`)
    return cached
  }
  console.error(`[ai] NO config for ${cacheKey} — agent will run without prices or hotel facts`)
  return { ai: null, hotelId: null }
}

/**
 * Call PPG.
 *
 * This used to rewrite every request to the internal `coolify-proxy` with a Host
 * header, to dodge hairpin-NAT loopback on the VPS. That shortcut has been
 * answering **"404 page not found"** — plain text, so `JSON.parse` died on
 * "Unexpected non-whitespace character after JSON at position 4" (it reads the
 * "404" as a number, then chokes on " page"). Every inbound DID lookup in the
 * logs shows that line, and the AI extension silently lost its whole PPG
 * context with it: no prices, no hotel facts, no vocabulary, no few-shot. An
 * agent with no price list is exactly an agent that invents prices.
 *
 * Direct HTTPS was verified working from inside this container (200 + valid
 * JSON), so it is now the default. The internal hop stays available behind
 * PPG_USE_INTERNAL_PROXY for the day hairpin NAT comes back — but it FALLS BACK
 * to direct instead of failing the call, because a broken shortcut must never
 * again masquerade as a broken API.
 */
const USE_INTERNAL_PROXY = process.env.PPG_USE_INTERNAL_PROXY === '1'

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (!USE_INTERNAL_PROXY || !url.includes('ppg.pmapartner.com')) {
    return fetch(url, { ...options, headers })
  }
  const internalUrl = url.replace('https://ppg.pmapartner.com', 'http://coolify-proxy')
  try {
    const r = await fetch(internalUrl, { ...options, headers: { ...headers, Host: 'ppg.pmapartner.com' } })
    if (r.ok) return r
    console.warn(`[ppg] internal proxy returned ${r.status} — retrying directly`)
  } catch (e) {
    console.warn(`[ppg] internal proxy failed (${e.message}) — retrying directly`)
  }
  return fetch(url, { ...options, headers })
}

// ── rtpengine client (optional — only used when host is configured) ─────────
const rtpengine = RTPENGINE_HOST
  ? new RtpEngineClient(RTPENGINE_HOST, RTPENGINE_PORT)
  : null

if (rtpengine) {
  rtpengine.ping()
    .then(r => console.log('[rtpengine] ping OK:', JSON.stringify(r)))
    .catch(e => console.error('[rtpengine] ping FAILED:', e.message))
}

// ── AI voice concierge: answers calls to AI_EXT locally (no PBX forward) ─────
const { AiCall, AI_EXT, AI_RTP_PORT, PUBLIC_IP: AI_PUBLIC } = require('./ai-agent')
const { providerStatus } = require('./providers')
// Call-ID → { call, toTag, answerSdp }. toTag + answerSdp are kept so a
// session-timer refresh (in-dialog re-INVITE/UPDATE) can be answered in-dialog.
const aiDialogs = new Map()

/**
 * Echo the peer's session timer back so it re-arms, naming the CALLER as the
 * refresher. The AI leg is a UAS with no re-INVITE machinery of its own, so it
 * must never accept the refresher role — it would silently stop refreshing and
 * the call would drop exactly the way it did before this was handled.
 */
function sessionExpiresHeaders(sip) {
  const se = (sip.match(/^Session-Expires:\s*([^\r\n]+)/im) || [])[1]
  if (!se) return []
  const seconds = (se.match(/^\s*(\d+)/) || [])[1]
  if (!seconds) return []
  return [`Session-Expires: ${seconds};refresher=uac`, 'Require: timer']
}
console.log(`[ai] voice concierge enabled for extension ${AI_EXT} (rtp ${AI_PUBLIC}:${AI_RTP_PORT})`)

// ── Shared UDP socket to/from PBX ───────────────────────────────────────────
const udp = dgram.createSocket('udp4')

// Map of our Via branch IDs (we generate them) → SipSession instances.
// When PBX response comes in, we look up the top Via branch to find which
// WS session it belongs to.
const branchToSession = new Map()

// Also map Call-ID → session, for in-dialog requests from PBX
const callIdToSession = new Map()

// Inbound AI calls answered by this gateway (no WS session involved)
// callId → { call: AiCall, fromAddr: {address,port}, toTag, fromTag }
const inboundAiDialogs = new Map()

let totalSessions = 0
let activeSessions = 0
let totalToPbx = 0
let totalToClient = 0

udp.on('message', (msg, rinfo) => {
  const sip = msg.toString('utf8')
  if (LOG_SIP) {
    console.log(`[udp ←${rinfo.address}:${rinfo.port}] ─── ${msg.length} bytes ───`)
    console.log(sip.replace(/\r\n/g, '\n').slice(0, 1500))
    console.log(`[udp ←] ─── end ───`)
  }

  // Find our branch in the top Via to identify the session
  const firstViaMatch = sip.match(/^Via:\s*([^\r\n]+)/im)
  let session = null
  if (firstViaMatch) {
    const branchMatch = firstViaMatch[1].match(/branch=(z9hG4bK-gw-[a-f0-9-]+)/i)
    if (branchMatch) {
      session = branchToSession.get(branchMatch[1])
    }
  }

  // For in-dialog requests from PBX (not responses), look up by Call-ID
  if (!session) {
    const cidMatch = sip.match(/^Call-ID:\s*([^\r\n]+)/im)
    if (cidMatch) session = callIdToSession.get(cidMatch[1].trim())
  }

  if (!session) {
    // ── inbound AI dialog (ACK / BYE for calls we answered) ───────────────
    const cidAi = (sip.match(/^Call-ID:\s*([^\r\n]+)/im)?.[1] || '').trim()
    if (cidAi && inboundAiDialogs.has(cidAi)) {
      handleInboundAiDialog(sip, rinfo, cidAi)
      return
    }
    // ── new inbound INVITE from PBX ───────────────────────────────────────
    if (/^INVITE\s/i.test(sip.split('\r\n')[0])) {
      handleInboundInvite(sip, rinfo).catch(e => console.error('[inbound]', e.message))
      return
    }
    console.warn(`[udp ←] no session match — dropping`)
    return
  }

  session.onPbxMessage(sip)
})

udp.on('error', (err) => {
  console.error('[udp] error:', err.message)
})

udp.bind(UDP_PORT, '0.0.0.0', () => {
  console.log(`[udp] bound to 0.0.0.0:${UDP_PORT}`)
})

// ── HTTP server ─────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      uptime: process.uptime(),
      activeSessions,
      totalSessions,
      totalToPbx,
      totalToClient,
      pbx: `${PBX_HOST}:${PBX_PORT}/udp`,
      gateway: `${GATEWAY_HOST}:${UDP_PORT}`,
      activeAiCalls: inboundAiDialogs.size + aiDialogs.size,
      // Which STT/TTS/LLM providers actually have credentials right now — the
      // first thing to check when the AI "can't hear" or "won't speak".
      providers: providerStatus(),
    }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('ppg-sip-gateway — connect via WebSocket to /ws')
})

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  handleProtocols: (protocols) => protocols.has('sip') ? 'sip' : false,
})

// ── Per-connection session ──────────────────────────────────────────────────
class SipSession {
  constructor(ws, clientIp) {
    this.id = crypto.randomBytes(4).toString('hex')
    this.ws = ws
    this.clientIp = clientIp
    this.branches = new Set()
    this.callIds = new Set()
    this.closed = false
    this.clientTopVia = null  // remember client's top Via so we can restore it on responses
    this.lastOfferCallId = null
    this.lastOfferFromTag = null

    totalSessions++
    activeSessions++
    console.log(`[${this.id}] open from ${clientIp} (active=${activeSessions})`)

    ws.on('message', (data) => this.onClientMessage(data))
    ws.on('close', () => this.close())
    ws.on('error', (err) => {
      console.error(`[${this.id}] WS error:`, err.message)
      this.close()
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    activeSessions--
    // Clean up our branch entries
    for (const b of this.branches) branchToSession.delete(b)
    for (const c of this.callIds) callIdToSession.delete(c)
    // Tear down rtpengine session if any
    if (rtpengine && this.lastOfferCallId) {
      rtpengine.delete({ callId: this.lastOfferCallId, fromTag: this.lastOfferFromTag })
        .catch(() => {})
    }
    try { this.ws.close() } catch {}
    console.log(`[${this.id}] closed (active=${activeSessions})`)
  }

  async onClientMessage(data) {
    const sip = data.toString('utf8')
    if (LOG_SIP) {
      console.log(`[${this.id} ←WS] ─── ${Buffer.byteLength(sip)} bytes ───`)
      console.log(sip.replace(/\r\n/g, '\n'))
      console.log(`[${this.id} ←WS] ─── end ───`)
    }

    // ── AI extension intercept: answer locally, never forward to PBX ─────────
    if (rtpengine && this.handleIfAi(sip)) return

    // Generate our own branch for this hop; lets us route responses
    const ourBranch = `z9hG4bK-gw-${this.id}-${crypto.randomBytes(4).toString('hex')}`
    this.branches.add(ourBranch)
    branchToSession.set(ourBranch, this)

    const ourVia = `Via: SIP/2.0/UDP ${GATEWAY_HOST}:${UDP_PORT};branch=${ourBranch};rport`

    // B2BUA-style: REPLACE all client Vias with our single Via (and remember
    // the client's top Via so we can put it back on responses). Many SIP
    // servers (Sippy, Kamailio) silently drop messages with .invalid hosts
    // in the Via chain, which JsSIP always uses for WSS.
    const clientViaMatch = sip.match(/^Via:\s*([^\r\n]+)/im)
    this.clientTopVia = clientViaMatch ? clientViaMatch[1] : null

    // Strip ALL Via headers from the client message, then prepend ours
    let rewritten = sip.replace(/^Via:[^\r\n]*\r\n/gim, '')
    const firstLineEnd = rewritten.indexOf('\r\n')
    if (firstLineEnd !== -1) {
      rewritten = rewritten.slice(0, firstLineEnd + 2) + ourVia + '\r\n' + rewritten.slice(firstLineEnd + 2)
    }

    // 2) Rewrite Contact — pointing to our gateway's UDP listener
    rewritten = rewritten.replace(
      /^(Contact:\s*(?:[^<\r\n]*<)?sip:)([^@\r\n]+)@([^>;\r\n]+)((?:[^>\r\n]*)>?[^\r\n]*)$/im,
      (_m, prefix, user, _oldHost, suffix) => {
        const cleanSuffix = (suffix || '')
          .replace(/;transport=wss?/gi, '')
        return `${prefix}${user}@${GATEWAY_HOST}:${UDP_PORT};transport=udp${cleanSuffix.startsWith('>') ? cleanSuffix : '>' + cleanSuffix.replace(/^>/, '')}`
      }
    )

    // 3) Track Call-ID for in-dialog matching
    const cidMatch = rewritten.match(/^Call-ID:\s*([^\r\n]+)/im)
    if (cidMatch) {
      const cid = cidMatch[1].trim()
      this.callIds.add(cid)
      callIdToSession.set(cid, this)
    }

    // 4) If this message carries SDP and rtpengine is configured,
    //    pass it through rtpengine offer/answer to bridge WebRTC ↔ PBX media.
    if (rtpengine) {
      const { headers, body } = splitSipMessage(rewritten)
      if (body && /Content-Type:\s*application\/sdp/i.test(headers)) {
        const callId = extractHeader(headers, 'Call-ID')
        const fromTag = extractTag(extractHeader(headers, 'From'))
        const toTag = extractTag(extractHeader(headers, 'To'))
        const firstLine = headers.split('\r\n')[0]
        const isRequest = !/^SIP\/2\.0/i.test(firstLine)
        const isResponse = /^SIP\/2\.0\s+\d+/i.test(firstLine)

        try {
          let result
          if (isRequest) {
            // Client → PBX with SDP → "offer"
            result = await rtpengine.offer({ callId, fromTag, sdp: body })
            this.lastOfferCallId = callId
            this.lastOfferFromTag = fromTag
          } else if (isResponse && toTag) {
            // Client sending response with SDP (rare on outbound) → "answer"
            result = await rtpengine.answer({ callId, fromTag, toTag, sdp: body })
          }
          if (result?.sdp) {
            rewritten = headers + '\r\n\r\n' + result.sdp
            if (LOG_SIP) console.log(`[${this.id}] SDP rewritten via rtpengine (${result.result || 'ok'})`)
          } else if (result?.['error-reason']) {
            console.warn(`[${this.id}] rtpengine error: ${result['error-reason']}`)
          }
        } catch (e) {
          console.error(`[${this.id}] rtpengine offer/answer failed:`, e.message)
        }
      }
    }

    // 5) Recompute Content-Length after any body changes
    rewritten = recomputeContentLength(rewritten)

    if (LOG_SIP) {
      console.log(`[${this.id} →PBX ${Buffer.byteLength(rewritten)} bytes rewritten]:`)
      console.log(rewritten.replace(/\r\n/g, '\n'))
    }

    totalToPbx++
    udp.send(rewritten, PBX_PORT, PBX_HOST, (err) => {
      if (err) console.error(`[${this.id}] UDP send failed:`, err.message)
    })
  }

  async onPbxMessage(sip) {
    // Replace our Via with the client's original top Via, so JsSIP recognises
    // the response (it matches by branch in its own Via).
    let stripped = sip
    if (this.clientTopVia) {
      stripped = stripped.replace(/^Via:[^\r\n]*\r\n/im, `Via: ${this.clientTopVia}\r\n`)
    } else {
      for (const b of this.branches) {
        const re = new RegExp(`^Via:[^\\r\\n]*${b}[^\\r\\n]*\\r\\n`, 'im')
        stripped = stripped.replace(re, '')
      }
    }

    // If the PBX response carries SDP, run it through rtpengine "answer" so
    // the WebRTC side gets DTLS-SRTP back instead of the PBX's plain RTP.
    if (rtpengine) {
      const { headers, body } = splitSipMessage(stripped)
      if (body && /Content-Type:\s*application\/sdp/i.test(headers)) {
        const callId = extractHeader(headers, 'Call-ID')
        const fromTag = extractTag(extractHeader(headers, 'From'))
        const toTag = extractTag(extractHeader(headers, 'To'))
        try {
          const r = await rtpengine.answer({ callId, fromTag, toTag, sdp: body })
          if (r?.sdp) {
            stripped = headers + '\r\n\r\n' + r.sdp
            stripped = recomputeContentLength(stripped)
            if (LOG_SIP) console.log(`[${this.id}] PBX SDP rewritten via rtpengine`)
          } else if (r?.['error-reason']) {
            console.warn(`[${this.id}] rtpengine answer error: ${r['error-reason']}`)
          }
        } catch (e) {
          console.error(`[${this.id}] rtpengine answer failed:`, e.message)
        }
      }

      // Clean up rtpengine session on BYE/CANCEL
      const firstLine = stripped.split('\r\n')[0]
      if (/^(BYE|CANCEL)\s/i.test(firstLine) && this.lastOfferCallId) {
        rtpengine.delete({ callId: this.lastOfferCallId, fromTag: this.lastOfferFromTag })
          .catch(() => {})
      }
    }

    if (LOG_SIP) {
      console.log(`[${this.id} →WS ${Buffer.byteLength(stripped)} bytes]:`)
      console.log(stripped.replace(/\r\n/g, '\n'))
    }

    totalToClient++
    if (this.ws.readyState === 1 /* OPEN */) {
      try { this.ws.send(stripped) }
      catch (err) { console.error(`[${this.id}] WS send failed:`, err.message) }
    }
  }

  // ── AI extension handling ────────────────────────────────────────────────
  // Returns true if this message belongs to the AI extension (handled locally).
  handleIfAi(sip) {
    const firstLine = sip.split('\r\n')[0]
    const reqM = firstLine.match(/^([A-Z]+)\s+sips?:([^@\s;>]+)(?:@|\s)/i)
    const method = reqM ? reqM[1].toUpperCase() : null
    const callId = (sip.match(/^Call-ID:\s*([^\r\n]+)/im)?.[1] || '').trim()

    // In-dialog requests for an active AI call
    if (callId && aiDialogs.has(callId)) {
      const d = aiDialogs.get(callId)
      if (method === 'BYE' || method === 'CANCEL') {
        this.sendToClient(this.buildResponse(sip, 200, 'OK'))
        aiDialogs.delete(callId)
        try { d.call.close() } catch {}
        rtpengine.delete({ callId, fromTag: extractTag(extractHeader(sip, 'From')) }).catch(() => {})
        console.log(`[ai] call ${callId} ended (${method})`)
        return true
      }
      if (method === 'ACK') return true          // nothing to answer
      // SESSION REFRESH. A session timer (RFC 4028) is refreshed with an
      // in-dialog re-INVITE or UPDATE. These used to be swallowed with no
      // reply, so the refresher timed out and tore the call down mid-sentence
      // with `BYE ... cause=408 "Request Timeout"` — the caller heard the line
      // simply die. Answer them, re-arming the timer.
      if (method === 'INVITE' || method === 'UPDATE') {
        const withSdp = method === 'INVITE' || /^Content-Type:\s*application\/sdp/im.test(sip)
        this.sendToClient(this.buildResponse(sip, 200, 'OK', {
          toTag: d.toTag,
          extra: [
            `Contact: <sip:${AI_EXT}@${GATEWAY_HOST}:${UDP_PORT};transport=udp>`,
            ...sessionExpiresHeaders(sip),
            ...(withSdp && d.answerSdp ? ['Content-Type: application/sdp'] : []),
          ],
          body: withSdp && d.answerSdp ? d.answerSdp : '',
        }))
        console.log(`[ai] session refresh ${method} answered for ${callId}`)
        return true
      }
      if (method === 'OPTIONS' || method === 'INFO' || method === 'NOTIFY') {
        this.sendToClient(this.buildResponse(sip, 200, 'OK', { toTag: d.toTag }))
        return true
      }
      return true
    }

    // New INVITE to the AI extension → answer with the voice concierge
    if (method === 'INVITE' && reqM[2] === AI_EXT) {
      this.handleAiInvite(sip, callId).catch(e => console.error('[ai] invite error:', e.message))
      return true
    }
    return false
  }

  async handleAiInvite(sip, callId) {
    const { body } = splitSipMessage(sip)
    const fromTag = extractTag(extractHeader(sip, 'From'))
    if (!body) { this.sendToClient(this.buildResponse(sip, 488, 'Not Acceptable Here')); return }

    // 1) Feed the browser's WebRTC offer to rtpengine → plain-PCMU "callee" SDP.
    let offerRes = null
    try { offerRes = await rtpengine.offer({ callId, fromTag, sdp: body }) } catch (e) { console.error('[ai] rtpengine offer:', e.message) }
    const calleeSdp = offerRes?.sdp || ''
    const rIp = (calleeSdp.match(/^c=IN IP4 (\S+)/m) || [])[1]
    const rPort = parseInt((calleeSdp.match(/^m=audio (\d+)/m) || [])[1] || '0', 10)
    if (!rIp || !rPort) { console.error('[ai] no rtpengine media addr'); this.sendToClient(this.buildResponse(sip, 500, 'Server Internal Error')); return }

    // 2) Our AI media (PCMU @ our published RTP port) → rtpengine.answer → browser SDP.
    const toTag = crypto.randomBytes(6).toString('hex')
    const aiSdp = [
      'v=0', `o=ai 0 0 IN IP4 ${AI_PUBLIC}`, 's=ppg-ai', `c=IN IP4 ${AI_PUBLIC}`, 't=0 0',
      `m=audio ${AI_RTP_PORT} RTP/AVP 0 101`, 'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=ptime:20', 'a=sendrecv', '',
    ].join('\r\n')
    let ansRes = null
    try { ansRes = await rtpengine.answer({ callId, fromTag, toTag, sdp: aiSdp }) } catch (e) { console.error('[ai] rtpengine answer:', e.message) }
    const browserSdp = ansRes?.sdp
    if (!browserSdp) { console.error('[ai] rtpengine answer failed'); this.sendToClient(this.buildResponse(sip, 500, 'Server Internal Error')); return }

    // 3) 200 OK with the WebRTC answer. Session-Expires is echoed with
    //    refresher=uac so the peer keeps the dialog alive (see the helper).
    this.sendToClient(this.buildResponse(sip, 200, 'OK', {
      toTag,
      extra: [
        `Contact: <sip:${AI_EXT}@${GATEWAY_HOST}:${UDP_PORT};transport=udp>`,
        ...sessionExpiresHeaders(sip),
        'Content-Type: application/sdp',
      ],
      body: browserSdp,
    }))

    // 4) Load the hotel's AI config (prices, hotel info, agent, offer capability)
    //    so the direct AI extension behaves like a real DID call. Which hotel the
    //    7000 extension represents is set via AI_DEFAULT_HOTEL (slug). Without it,
    //    the agent runs generic (no prices/offers).
    const caller = (extractHeader(sip, 'From').match(/sips?:(\+?[\d]+)@/i) || [])[1] || ''
    let aiCfg = null, hotelId = null
    if (AI_DEFAULT_HOTEL) {
      const got = await loadHotelConfig(
        `${PPG_API_URL}/api/cc/route?hotelSlug=${encodeURIComponent(AI_DEFAULT_HOTEL)}${caller ? `&caller=${encodeURIComponent(caller)}` : ''}`,
        AI_DEFAULT_HOTEL,
      )
      aiCfg = got.ai
      hotelId = got.hotelId
    }

    // 5) Start the voice agent (PCMU RTP via rtpengine ↔ STT/LLM/TTS).
    const call = new AiCall({
      remoteIp: rIp, remotePort: rPort,
      greetingOverride:      aiCfg?.greeting || undefined,
      agentName:             aiCfg?.agentName || undefined,
      defaultAgentName:      aiCfg?.defaultAgentName || undefined,
      voiceProfiles:         aiCfg?.voiceProfiles || undefined,
      defaultVoiceProfileId: aiCfg?.defaultVoiceProfileId || undefined,
      priceContext:          aiCfg?.priceContext || undefined,
      hotelInfo:             aiCfg?.hotelInfo || undefined,
      sttVocabulary:         aiCfg?.sttVocabulary || undefined,
      fewShot:               aiCfg?.fewShot || undefined,
      hotelId, callId, caller,
      onEnd:                 reportCallRecord,
      onAction:              executeAiAction,
      onTool:                checkAvailability,
    })
    aiDialogs.set(callId, { call, toTag, answerSdp: browserSdp })
    this.callIds.add(callId)
    console.log(`[ai] answered ${AI_EXT} (call ${callId}) hotel=${AI_DEFAULT_HOTEL || 'generic'} → media to ${rIp}:${rPort}`)
  }

  sendToClient(msg) {
    if (this.ws.readyState === 1) { try { this.ws.send(msg) } catch (e) { console.error('[ai] ws send:', e.message) } }
  }

  // Build a SIP response from a request: copy Via/From/Call-ID/CSeq verbatim,
  // add a tag to To, append extra headers + body.
  buildResponse(reqSip, code, reason, opts = {}) {
    const { headers } = splitSipMessage(reqSip)
    const lines = headers.split('\r\n')
    const out = [`SIP/2.0 ${code} ${reason}`]
    for (const ln of lines.slice(1)) {
      if (/^(Via|From|Call-ID|CSeq):/i.test(ln)) out.push(ln)
      else if (/^To:/i.test(ln)) out.push(opts.toTag && !/;tag=/i.test(ln) ? `${ln};tag=${opts.toTag}` : ln)
    }
    for (const e of (opts.extra || [])) out.push(e)
    const body = opts.body || ''
    out.push(`Content-Length: ${Buffer.byteLength(body)}`)
    return out.join('\r\n') + '\r\n\r\n' + body
  }
}

// ── Inbound call handling (PBX → gateway, no WS session) ───────────────────

// Build a SIP response from a request (standalone, mirrors SipSession.buildResponse)
function buildUdpResponse(reqSip, code, reason, opts = {}) {
  const { headers } = splitSipMessage(reqSip)
  const lines = headers.split('\r\n')
  const out = [`SIP/2.0 ${code} ${reason}`]
  for (const ln of lines.slice(1)) {
    if (/^(Via|From|Call-ID|CSeq):/i.test(ln)) out.push(ln)
    else if (/^To:/i.test(ln)) {
      out.push(opts.toTag && !/;tag=/i.test(ln) ? `${ln};tag=${opts.toTag}` : ln)
    }
  }
  for (const e of (opts.extra || [])) out.push(e)
  const body = opts.body || ''
  out.push(`Content-Length: ${Buffer.byteLength(body)}`)
  return out.join('\r\n') + '\r\n\r\n' + body
}

async function handleInboundInvite(sip, rinfo) {
  const reqLine = sip.split('\r\n')[0]
  // Extract DID: INVITE sip:908502523434@161.97.132.250:5070 SIP/2.0
  const didMatch = reqLine.match(/^INVITE\s+sips?:(\+?[\d]+)(?:@|\s)/i)
  const did = didMatch ? didMatch[1] : null
  const callId = (sip.match(/^Call-ID:\s*([^\r\n]+)/im)?.[1] || '').trim()
  const fromHeader = extractHeader(sip, 'From')
  const fromTag = extractTag(fromHeader)
  // Caller's number from the From URI (sip:CALLER@host) — used by PPG to pick
  // the contract currency (TR/Cyprus → TRY, others → EUR).
  const caller = (fromHeader.match(/sips?:(\+?[\d]+)@/i)?.[1] || '').trim()

  console.log(`[inbound] INVITE did=${did} call=${callId} caller=${caller || '?'} from=${rinfo.address}:${rinfo.port}`)

  // 100 Trying
  udp.send(Buffer.from(buildUdpResponse(sip, 100, 'Trying')), rinfo.port, rinfo.address)

  if (!did || !callId) {
    udp.send(Buffer.from(buildUdpResponse(sip, 404, 'Not Found')), rinfo.port, rinfo.address)
    return
  }

  // PPG DID lookup — same budget and last-good-copy fallback as the extension
  // path, so one slow response cannot drop a real inbound call.
  let routeInfo = null
  try {
    const url = `${PPG_API_URL}/api/cc/route?did=${encodeURIComponent(did)}${caller ? `&caller=${encodeURIComponent(caller)}` : ''}`
    const fetchHeaders = GATEWAY_SECRET ? { 'x-gateway-secret': GATEWAY_SECRET } : {}
    const r = await apiFetch(url, { headers: fetchHeaders, signal: AbortSignal.timeout(9000) })
    routeInfo = await r.json()
    if (routeInfo?.found) didRouteCache.set(did, { info: routeInfo, at: Date.now() })
  } catch (e) {
    console.error('[inbound] PPG lookup failed:', e.message)
    const cached = didRouteCache.get(did)
    if (cached && Date.now() - cached.at < CONFIG_TTL_MS) {
      console.warn(`[inbound] using cached route for ${did} (${Math.round((Date.now() - cached.at) / 1000)}s old)`)
      routeInfo = cached.info
    } else {
      udp.send(Buffer.from(buildUdpResponse(sip, 503, 'Service Unavailable')), rinfo.port, rinfo.address)
      return
    }
  }

  if (!routeInfo?.found) {
    console.log(`[inbound] DID ${did} not configured in PPG`)
    udp.send(Buffer.from(buildUdpResponse(sip, 404, 'Not Found')), rinfo.port, rinfo.address)
    return
  }

  const route  = routeInfo.resolved?.route
  const trunk  = routeInfo.trunk
  const reason = routeInfo.resolved?.routeReason

  if (!route) {
    udp.send(Buffer.from(buildUdpResponse(sip, 503, 'No Route Configured')), rinfo.port, rinfo.address)
    return
  }

  console.log(`[inbound] DID ${did} → route=${route.kind} reason=${reason}`)

  if (route.kind === 'ai') {
    await handleInboundAi(sip, rinfo, callId, fromTag, trunk, routeInfo?.ai, routeInfo?.hotelId, caller)
  } else if (route.kind === 'external' && route.externalNumber) {
    // Forward to external number via PBX re-INVITE (future)
    console.log(`[inbound] external forward to ${route.externalNumber} — not yet implemented`)
    udp.send(Buffer.from(buildUdpResponse(sip, 503, 'Not Implemented')), rinfo.port, rinfo.address)
  } else {
    // queue/agent/ivr/voicemail: ring connected WS softphone
    await handleInboundSoftphone(sip, rinfo, callId, fromTag, trunk, route)
  }
}

// Post-call lead capture: send the transcript + meta to PPG, which extracts the
// caller's name/phone and creates a CallRecord. Fire-and-forget; never blocks.
async function reportCallRecord(meta) {
  try {
    if (!meta || !meta.hotelId) return
    await apiFetch(`${PPG_API_URL}/api/cc/call-record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(GATEWAY_SECRET ? { 'x-gateway-secret': GATEWAY_SECRET } : {}) },
      body: JSON.stringify(meta),
      signal: AbortSignal.timeout(10000),
    })
    console.log(`[call-record] reported call ${meta.callId} (${(meta.transcript || []).length} turns)`)
  } catch (e) { console.error('[call-record] report failed:', e.message) }
}

/**
 * The AI's live lookup tool. The caller is on the line waiting, so this is a
 * SYNCHRONOUS request/response (unlike the fire-and-forget actions below): PPG
 * answers with the real rooms + prices for the requested dates and the agent
 * speaks that result. Returning null makes the agent apologise and hand off
 * rather than invent availability.
 */
async function checkAvailability(call) {
  const started = Date.now()
  try {
    if (!call?.hotelId) return null
    const r = await apiFetch(`${PPG_API_URL}/api/cc/availability`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(GATEWAY_SECRET ? { 'x-gateway-secret': GATEWAY_SECRET } : {}) },
      body: JSON.stringify({
        hotelId: call.hotelId,
        checkIn: call.checkIn,
        checkOut: call.checkOut,
        adults: call.adults,
        children: call.children,
        childAges: call.childAges,
        caller: call.caller,
      }),
      // The caller hears a "checking the system" filler during this window —
      // keep it well under the point where the line feels dead.
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => null)
    console.log(`[tool] check_availability ${call.checkIn}→${call.checkOut} (${Date.now() - started}ms) →`, JSON.stringify(j).slice(0, 220))
    if (!j || !j.ok) return null
    const res = j.result

    // SAFETY NET — never let the agent tell a caller the hotel is full on the
    // strength of missing data. The call-center contract publishes prices and
    // stop-sale but no room counts, so a server that reads a 0 count as "no
    // rooms" reports EVERY room sold out for EVERY date. PPG marks a
    // stock-aware answer with `stockDataAvailable`; its absence means the
    // server has no stock semantics at all, and a blanket sold-out from such a
    // server is unknown, not full. Returning null makes the agent apologise
    // and hand off to a human — the honest outcome.
    const blanketSoldOut = res && res.dataAvailable
      && res.anyAvailable === false
      && res.stockDataAvailable === undefined
      && Array.isArray(res.unavailable) && res.unavailable.length > 0
      && res.unavailable.every(u => u && u.reason === 'sold-out')
    if (blanketSoldOut) {
      console.warn('[tool] blanket sold-out with no stock semantics — treating as UNKNOWN, handing off')
      return null
    }
    return res
  } catch (e) {
    console.error('[tool] check_availability failed:', e.message)
    return null
  }
}

// Which extension each department answers on. Set as JSON, e.g.
//   AI_TRANSFER_EXT_MAP={"reception":"100","sales":"200","reservation":"300"}
// Falls back to AI_TRANSFER_EXT for any department without its own entry.
let TRANSFER_EXT_MAP = {}
try { TRANSFER_EXT_MAP = JSON.parse(process.env.AI_TRANSFER_EXT_MAP || '{}') }
catch { console.error('[transfer] AI_TRANSFER_EXT_MAP is not valid JSON — ignored') }

// Execute an [[ACTION]] the AI emitted: send a payment offer (email/WhatsApp/
// SMS) or hand off to a human. Both go through PPG /api/cc/ai-action; handoff
// also records the transcript + summary so the human agent sees it on screen.
async function executeAiAction(action) {
  try {
    const op = action.type === 'transfer' ? 'handoff' : (action.type === 'send_offer' ? 'send_offer' : null)
    if (!op) { console.log('[ai-action] unknown type', action.type); return }
    const r = await apiFetch(`${PPG_API_URL}/api/cc/ai-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(GATEWAY_SECRET ? { 'x-gateway-secret': GATEWAY_SECRET } : {}) },
      body: JSON.stringify({ op, ...action }),
      signal: AbortSignal.timeout(12000),
    })
    const j = await r.json().catch(() => ({}))
    console.log(`[ai-action] ${op} →`, JSON.stringify(j).slice(0, 180))
    // Best-effort SIP transfer of the live voice leg to a reception extension.
    // Gated by AI_TRANSFER_EXT; the transcript+summary are already on the agent
    // screen regardless, so reception can pick up / call back even without it.
    if (op === 'handoff') {
      const dept = (action.department || '').toLowerCase()
      const ext = action.extension || TRANSFER_EXT_MAP[dept] || process.env.AI_TRANSFER_EXT
      if (ext) {
        console.log(`[transfer] department=${dept || 'default'} → ext ${ext}`)
        transferToExtension(action.callId, ext)
      } else {
        console.log('[transfer] no extension for this department and no AI_TRANSFER_EXT — recorded for agent screen, no SIP transfer')
      }
    }
  } catch (e) { console.error('[ai-action] failed:', e.message) }
}

// In-dialog SIP REFER → transfer the live AI call to a reception extension.
// As the answering UAS, From=invite-To(+our toTag), To=invite-From(+caller tag).
// Best-effort: gated by AI_TRANSFER_EXT; the transcript+summary already reached
// the agent screen regardless. Needs live testing to confirm the PBX accepts it.
function transferToExtension(callId, ext) {
  const d = inboundAiDialogs.get(callId)
  if (!d || !d.inviteFrom) { console.log('[transfer] no dialog context for', callId); return }
  const host = d.reqUriHost || PBX_HOST || d.fromAddr.address
  const addTag = (hdr, tag) => /;tag=/i.test(hdr) ? hdr : `${hdr};tag=${tag}`
  const fromLine = addTag(d.inviteTo, d.toTag)     // we are the To-party of the INVITE
  const toLine = d.inviteFrom                        // caller already carries its own tag
  const branch = 'z9hG4bK' + crypto.randomBytes(6).toString('hex')
  const cseq = d.cseq || 2
  d.cseq = cseq + 1
  const refer = [
    `REFER sip:${ext}@${host} SIP/2.0`,
    `Via: SIP/2.0/UDP ${GATEWAY_HOST}:${UDP_PORT};branch=${branch}`,
    `Max-Forwards: 70`,
    `From: ${fromLine}`,
    `To: ${toLine}`,
    `Call-ID: ${d.callIdHdr}`,
    `CSeq: ${cseq} REFER`,
    `Contact: <sip:ai@${GATEWAY_HOST}:${UDP_PORT};transport=udp>`,
    `Refer-To: <sip:${ext}@${host}>`,
    `Referred-By: <sip:ai@${GATEWAY_HOST}>`,
    `Content-Length: 0`,
    '', '',
  ].join('\r\n')
  try {
    udp.send(Buffer.from(refer), d.fromAddr.port, d.fromAddr.address)
    console.log(`[transfer] REFER sent: call ${callId} → ${ext}@${host}`)
  } catch (e) { console.error('[transfer] REFER send failed:', e.message) }
}

async function handleInboundAi(sip, rinfo, callId, fromTag, trunk, aiCfg, hotelId, caller) {
  const { body } = splitSipMessage(sip)
  if (!body) {
    udp.send(Buffer.from(buildUdpResponse(sip, 488, 'Not Acceptable Here')), rinfo.port, rinfo.address)
    return
  }

  // Parse PBX SDP to find where they'll send media
  const pbxIp   = (body.match(/^c=IN IP4 (\S+)/m) || [])[1]
  const pbxPort = parseInt((body.match(/^m=audio (\d+)/m) || [])[1] || '0', 10)
  if (!pbxIp || !pbxPort) {
    console.error('[inbound:ai] no media address in PBX SDP')
    udp.send(Buffer.from(buildUdpResponse(sip, 488, 'Not Acceptable Here')), rinfo.port, rinfo.address)
    return
  }

  const toTag = crypto.randomBytes(6).toString('hex')

  // Our AI SDP: AI listens on AI_RTP_PORT, PBX sends PCMU there
  const aiSdp = [
    'v=0',
    `o=ai 0 0 IN IP4 ${AI_PUBLIC}`,
    's=ppg-ai',
    `c=IN IP4 ${AI_PUBLIC}`,
    't=0 0',
    `m=audio ${AI_RTP_PORT} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n')

  const ok200 = buildUdpResponse(sip, 200, 'OK', {
    toTag,
    extra: [
      `Contact: <sip:ai@${GATEWAY_HOST}:${UDP_PORT};transport=udp>`,
      ...sessionExpiresHeaders(sip),
      'Content-Type: application/sdp',
    ],
    body: aiSdp,
  })
  udp.send(Buffer.from(ok200), rinfo.port, rinfo.address)

  const call = new AiCall({
    remoteIp: pbxIp,
    remotePort: pbxPort,
    greetingOverride:      aiCfg?.greeting      || trunk?.greetingText || undefined,
    agentName:             aiCfg?.agentName        || undefined,
    defaultAgentName:      aiCfg?.defaultAgentName || undefined,
    voiceProfiles:         aiCfg?.voiceProfiles  || undefined,
    defaultVoiceProfileId: aiCfg?.defaultVoiceProfileId || undefined,
    priceContext:          aiCfg?.priceContext   || undefined,
    hotelInfo:             aiCfg?.hotelInfo      || undefined,
    sttVocabulary:         aiCfg?.sttVocabulary  || undefined,
    fewShot:               aiCfg?.fewShot        || undefined,
    hotelId,
    callId,
    caller,
    onEnd:                 reportCallRecord,
    onAction:              executeAiAction,
    onTool:                checkAvailability,
  })
  // Capture dialog context for a possible in-dialog REFER (live transfer).
  const reqUriHost = (sip.split('\r\n')[0].match(/sips?:[^@\s]+@([^;>\s]+)/i) || [])[1] || pbxIp
  const inviteFrom = extractHeader(sip, 'From')
  const inviteTo = extractHeader(sip, 'To')
  const callIdHdr = (sip.match(/^Call-ID:\s*([^\r\n]+)/im)?.[1] || callId).trim()
  inboundAiDialogs.set(callId, { call, fromAddr: rinfo, toTag, fromTag, inviteFrom, inviteTo, callIdHdr, reqUriHost, cseq: 2, answerSdp: aiSdp })
  const profileId = call.currentProfile?.id || '?'
  console.log(`[inbound:ai] answered ${callId} — PBX ${pbxIp}:${pbxPort} ↔ AI :${AI_RTP_PORT} agent=${call.agentName} profile=${profileId}`)
}

function handleInboundAiDialog(sip, rinfo, callId) {
  const dialog = inboundAiDialogs.get(callId)
  const firstLine = sip.split('\r\n')[0]
  if (/^ACK\s/i.test(firstLine)) return  // absorb silently
  if (/^BYE\s/i.test(firstLine)) {
    udp.send(Buffer.from(buildUdpResponse(sip, 200, 'OK')), rinfo.port, rinfo.address)
    if (dialog?.call) { try { dialog.call.close() } catch {} }
    inboundAiDialogs.delete(callId)
    console.log(`[inbound:ai] call ${callId} ended (BYE)`)
    return
  }
  if (/^CANCEL\s/i.test(firstLine)) {
    udp.send(Buffer.from(buildUdpResponse(sip, 200, 'OK')), rinfo.port, rinfo.address)
    if (dialog?.call) { try { dialog.call.close() } catch {} }
    inboundAiDialogs.delete(callId)
    console.log(`[inbound:ai] call ${callId} cancelled`)
    return
  }
  // SESSION REFRESH (RFC 4028) — see sessionExpiresHeaders(). Left unanswered,
  // the refresher tears the call down mid-sentence with cause=408.
  if (/^(INVITE|UPDATE)\s/i.test(firstLine)) {
    const isInvite = /^INVITE\s/i.test(firstLine)
    const withSdp = isInvite || /^Content-Type:\s*application\/sdp/im.test(sip)
    udp.send(Buffer.from(buildUdpResponse(sip, 200, 'OK', {
      toTag: dialog?.toTag,
      extra: [
        `Contact: <sip:ai@${GATEWAY_HOST}:${UDP_PORT};transport=udp>`,
        ...sessionExpiresHeaders(sip),
        ...(withSdp && dialog?.answerSdp ? ['Content-Type: application/sdp'] : []),
      ],
      body: withSdp && dialog?.answerSdp ? dialog.answerSdp : '',
    })), rinfo.port, rinfo.address)
    console.log(`[inbound:ai] session refresh answered for ${callId}`)
    return
  }
  if (/^(OPTIONS|INFO|NOTIFY)\s/i.test(firstLine)) {
    udp.send(Buffer.from(buildUdpResponse(sip, 200, 'OK', { toTag: dialog?.toTag })), rinfo.port, rinfo.address)
  }
}

async function handleInboundSoftphone(sip, rinfo, callId, fromTag, trunk, route) {
  // Find a connected WebSocket agent to ring.
  // For now: ring first connected WS client; full queue/priority routing is Phase 2.
  const openClients = [...wss.clients].filter(ws => ws.readyState === 1 /* OPEN */)
  if (openClients.length === 0) {
    console.log(`[inbound:softphone] no agents online for ${callId} (DID ${trunk?.number})`)
    udp.send(Buffer.from(buildUdpResponse(sip, 480, 'Temporarily Unavailable')), rinfo.port, rinfo.address)
    return
  }

  // TODO: Phase 2 — re-INVITE PBX SDP via rtpengine, forward to WS softphone,
  // bridge responses back. For now send 480 to inform PBX no agent answered.
  // Agent can see the call on the wallboard and call back via the softphone.
  console.log(`[inbound:softphone] ${openClients.length} agent(s) online but WS-ring not yet implemented for ${callId}`)
  udp.send(Buffer.from(buildUdpResponse(sip, 480, 'Temporarily Unavailable')), rinfo.port, rinfo.address)
}

// ── SIP utility helpers ─────────────────────────────────────────────────────
function splitSipMessage(sip) {
  const sep = sip.indexOf('\r\n\r\n')
  if (sep === -1) return { headers: sip, body: '' }
  return { headers: sip.slice(0, sep), body: sip.slice(sep + 4) }
}

function extractHeader(headers, name) {
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]+)`, 'im')
  const m = headers.match(re)
  return m ? m[1].trim() : ''
}

function extractTag(headerValue) {
  if (!headerValue) return ''
  const m = headerValue.match(/;tag=([^;\s]+)/i)
  return m ? m[1] : ''
}

function recomputeContentLength(sip) {
  const sep = sip.indexOf('\r\n\r\n')
  if (sep === -1) return sip
  const headers = sip.slice(0, sep)
  const body = sip.slice(sep + 4)
  const bodyLen = Buffer.byteLength(body, 'utf8')
  const newHeaders = headers.replace(
    /^Content-Length:\s*\d+/im,
    `Content-Length: ${bodyLen}`
  )
  if (newHeaders === headers && bodyLen > 0 && !/^Content-Length:/im.test(headers)) {
    return newHeaders + `\r\nContent-Length: ${bodyLen}\r\n\r\n` + body
  }
  return newHeaders + '\r\n\r\n' + body
}

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim()
                || req.socket.remoteAddress
                || 'unknown'
  new SipSession(ws, clientIp)
})

httpServer.listen(PORT, () => {
  console.log(`ppg-sip-gateway listening on :${PORT}`)
  console.log(`  WSS path:     /ws`)
  console.log(`  Health:       /health`)
  console.log(`  PBX target:   ${PBX_HOST}:${PBX_PORT} (udp)`)
  console.log(`  Gateway:      ${GATEWAY_HOST}:${UDP_PORT} (single shared UDP socket)`)
  console.log(`  Log SIP:      ${LOG_SIP}`)
})

function shutdown() {
  console.log('Shutting down...')
  wss.clients.forEach((ws) => ws.close())
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('uncaughtException', (e) => console.error('uncaughtException:', e))
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e))
