// ppg-sip-gateway — translates SIP-over-WebSocket (browser/Electron JsSIP)
// to SIP-over-UDP for legacy PBX systems that lack native WSS support.
//
// Architecture:
//   JsSIP ──wss──▶ this gateway ──udp──▶ PBX
//
// Each WebSocket connection gets its own UDP socket. We rewrite Via and
// Contact headers so SIP routing works correctly across the transport bridge.

const http = require('http')
const dgram = require('dgram')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

// ── Config from env ─────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '8080', 10)
const PBX_HOST         = process.env.PBX_HOST || '90.158.44.140'
const PBX_PORT         = parseInt(process.env.PBX_PORT || '5060', 10)
const PBX_TRANSPORT    = (process.env.PBX_TRANSPORT || 'udp').toLowerCase()
const GATEWAY_HOST     = process.env.GATEWAY_HOST || 'sip-gw.bluedreamsresort.com'
const LOG_SIP          = process.env.LOG_SIP === '1'

if (PBX_TRANSPORT !== 'udp') {
  console.error(`[gateway] Only UDP transport is supported (got ${PBX_TRANSPORT})`)
  process.exit(1)
}

// ── Stats / heartbeat ───────────────────────────────────────────────────────
let totalSessions = 0
let activeSessions = 0
let totalToPbx = 0
let totalToClient = 0

// ── HTTP server (for healthcheck + WebSocket upgrade) ───────────────────────
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
      pbx: `${PBX_HOST}:${PBX_PORT}/${PBX_TRANSPORT}`,
    }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('ppg-sip-gateway — connect via WebSocket to /ws')
})

// ── WebSocket server on /ws ─────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  handleProtocols: (protocols) => {
    // JsSIP sends Sec-WebSocket-Protocol: sip
    return protocols.has('sip') ? 'sip' : false
  },
})

// ── Per-connection session ──────────────────────────────────────────────────
class SipSession {
  constructor(ws, clientIp) {
    this.id = crypto.randomBytes(4).toString('hex')
    this.ws = ws
    this.clientIp = clientIp
    this.udp = dgram.createSocket('udp4')
    this.localUdpPort = null
    this.ourBranchPrefix = `z9hG4bK-gw-${this.id}-`
    this.closed = false

    totalSessions++
    activeSessions++
    console.log(`[${this.id}] open from ${clientIp} (active=${activeSessions})`)

    this.udp.on('message', (msg) => this.onPbxMessage(msg))
    this.udp.on('error', (err) => {
      console.error(`[${this.id}] UDP error:`, err.message)
      this.close()
    })

    this.udp.bind(0, () => {
      this.localUdpPort = this.udp.address().port
      console.log(`[${this.id}] UDP bound to ${this.localUdpPort}`)
    })

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
    try { this.udp.close() } catch {}
    try { this.ws.close() } catch {}
    console.log(`[${this.id}] closed (active=${activeSessions})`)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Client (JsSIP) → PBX
  // - Insert our Via at the TOP so PBX sends replies back to us
  // - Rewrite Contact so PBX sends in-dialog requests back to us
  // ─────────────────────────────────────────────────────────────────────────
  onClientMessage(data) {
    const sip = data.toString('utf8')
    if (LOG_SIP) {
      console.log(`[${this.id} →PBX] ─── client message (${Buffer.byteLength(sip)} bytes) ───`)
      console.log(sip.replace(/\r\n/g, '\n'))
      console.log(`[${this.id} →PBX] ─── end ───`)
    }

    const ourVia = `Via: SIP/2.0/UDP ${GATEWAY_HOST}:${this.localUdpPort};branch=${this.ourBranchPrefix}${crypto.randomBytes(4).toString('hex')};rport`

    let rewritten = sip

    // 1) Insert our Via at the top (before any existing Via)
    const viaInsertPoint = rewritten.search(/^Via:/im)
    if (viaInsertPoint !== -1) {
      rewritten = rewritten.slice(0, viaInsertPoint) + ourVia + '\r\n' + rewritten.slice(viaInsertPoint)
    } else {
      // No Via — insert after the request/status line
      const firstLineEnd = rewritten.indexOf('\r\n')
      if (firstLineEnd !== -1) {
        rewritten = rewritten.slice(0, firstLineEnd + 2) + ourVia + '\r\n' + rewritten.slice(firstLineEnd + 2)
      }
    }

    // 2) Rewrite Contact header — JsSIP uses transport=ws and a fake hostname
    //    We replace it with our gateway IP:UDP-port so the PBX can reach us
    rewritten = rewritten.replace(
      /^(Contact:\s*(?:[^<\r\n]*<)?sip:)([^@\r\n]+)@([^>;\r\n]+)((?:[^>\r\n]*)>?[^\r\n]*)$/im,
      (_m, prefix, user, _oldHost, suffix) => {
        // Strip transport=ws / ;ws / ;wss from suffix
        const cleanSuffix = suffix
          .replace(/;transport=wss?/gi, '')
          .replace(/>;/, '>;')
        return `${prefix}${user}@${GATEWAY_HOST}:${this.localUdpPort};transport=udp${cleanSuffix.startsWith('>') ? cleanSuffix : '>' + cleanSuffix.replace(/^>/, '')}`
      }
    )

    // 3) Recompute Content-Length to be safe (CRLF body separation)
    rewritten = recomputeContentLength(rewritten)

    if (LOG_SIP) {
      console.log(`[${this.id} →PBX rewritten ${Buffer.byteLength(rewritten)} bytes]:`)
      console.log(rewritten.replace(/\r\n/g, '\n'))
      console.log(`[${this.id} →PBX] sending to ${PBX_HOST}:${PBX_PORT} from local port ${this.localUdpPort}`)
    }

    totalToPbx++
    this.udp.send(rewritten, PBX_PORT, PBX_HOST, (err) => {
      if (err) console.error(`[${this.id}] UDP send failed:`, err.message)
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PBX → Client (JsSIP)
  // - Remove our top Via (the response is for us; we strip it)
  // - Forward via WebSocket
  // ─────────────────────────────────────────────────────────────────────────
  onPbxMessage(msg) {
    let sip = msg.toString('utf8')
    if (LOG_SIP) {
      console.log(`[${this.id} ←PBX] ─── pbx message (${msg.length} bytes) ───`)
      console.log(sip.replace(/\r\n/g, '\n'))
      console.log(`[${this.id} ←PBX] ─── end ───`)
    }

    // Remove ONLY our Via (identified by our branch prefix)
    sip = sip.replace(
      new RegExp(`^Via:[^\\r\\n]*${this.ourBranchPrefix}[^\\r\\n]*\\r\\n`, 'im'),
      ''
    )

    totalToClient++
    if (this.ws.readyState === 1 /* OPEN */) {
      try { this.ws.send(sip) }
      catch (err) { console.error(`[${this.id}] WS send failed:`, err.message) }
    }
  }
}

// ── SIP utilities ───────────────────────────────────────────────────────────
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
  // If no Content-Length header existed but a body does, add one
  if (newHeaders === headers && bodyLen > 0 && !/^Content-Length:/im.test(headers)) {
    return newHeaders + `\r\nContent-Length: ${bodyLen}\r\n\r\n` + body
  }
  return newHeaders + '\r\n\r\n' + body
}

// ── Wire up ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim()
                || req.socket.remoteAddress
                || 'unknown'
  new SipSession(ws, clientIp)
})

httpServer.listen(PORT, () => {
  console.log(`ppg-sip-gateway listening on :${PORT}`)
  console.log(`  WSS path:    /ws`)
  console.log(`  Health:      /health`)
  console.log(`  PBX target:  ${PBX_HOST}:${PBX_PORT} (${PBX_TRANSPORT})`)
  console.log(`  Gateway FQDN: ${GATEWAY_HOST}`)
  console.log(`  Log SIP:     ${LOG_SIP}`)
})

// Graceful shutdown
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
