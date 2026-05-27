// ppg-sip-gateway — translates SIP-over-WebSocket to SIP-over-UDP
//
// Single shared UDP socket on a fixed port; sessions identified by the
// branch parameter in our own Via. Lets us run behind Docker port mapping
// (one UDP port for the whole gateway, not random per-session ports).

const http = require('http')
const dgram = require('dgram')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const PORT          = parseInt(process.env.PORT || '8080', 10)
const UDP_PORT      = parseInt(process.env.UDP_PORT || '5070', 10)
const PBX_HOST      = process.env.PBX_HOST || '90.158.44.140'
const PBX_PORT      = parseInt(process.env.PBX_PORT || '5060', 10)
const GATEWAY_HOST  = process.env.GATEWAY_HOST || '76.13.0.113'
const LOG_SIP       = process.env.LOG_SIP === '1'

// ── Shared UDP socket to/from PBX ───────────────────────────────────────────
const udp = dgram.createSocket('udp4')

// Map of our Via branch IDs (we generate them) → SipSession instances.
// When PBX response comes in, we look up the top Via branch to find which
// WS session it belongs to.
const branchToSession = new Map()

// Also map Call-ID → session, for in-dialog requests from PBX
const callIdToSession = new Map()

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
    try { this.ws.close() } catch {}
    console.log(`[${this.id}] closed (active=${activeSessions})`)
  }

  onClientMessage(data) {
    const sip = data.toString('utf8')
    if (LOG_SIP) {
      console.log(`[${this.id} ←WS] ─── ${Buffer.byteLength(sip)} bytes ───`)
      console.log(sip.replace(/\r\n/g, '\n'))
      console.log(`[${this.id} ←WS] ─── end ───`)
    }

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

    // 4) Recompute Content-Length
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

  onPbxMessage(sip) {
    // Replace our Via with the client's original top Via, so JsSIP recognises
    // the response (it matches by branch in its own Via).
    let stripped = sip
    if (this.clientTopVia) {
      // Replace the FIRST Via line entirely with the client's via
      stripped = stripped.replace(/^Via:[^\r\n]*\r\n/im, `Via: ${this.clientTopVia}\r\n`)
    } else {
      // Fall back: strip our Via (with our branch prefix)
      for (const b of this.branches) {
        const re = new RegExp(`^Via:[^\\r\\n]*${b}[^\\r\\n]*\\r\\n`, 'im')
        stripped = stripped.replace(re, '')
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
