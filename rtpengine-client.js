// Minimal rtpengine ng-protocol client.
//
// ng-protocol uses Bencode-encoded UDP messages. Each message is prefixed
// by a unique cookie token used to correlate requests/responses.

const dgram  = require('dgram')
const crypto = require('crypto')

// ── Bencode encoder ─────────────────────────────────────────────────────────
function bencode(obj) {
  if (typeof obj === 'string') return `${Buffer.byteLength(obj, 'utf8')}:${obj}`
  if (typeof obj === 'number' && Number.isInteger(obj)) return `i${obj}e`
  if (Array.isArray(obj)) return `l${obj.map(bencode).join('')}e`
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    return `d${keys.map(k => bencode(k) + bencode(obj[k])).join('')}e`
  }
  throw new Error('Cannot bencode: ' + JSON.stringify(obj))
}

// ── Bencode decoder ─────────────────────────────────────────────────────────
function bdecode(buf, posRef = { pos: 0 }) {
  const c = String.fromCharCode(buf[posRef.pos])
  if (c === 'i') {
    const end = buf.indexOf(0x65 /* 'e' */, posRef.pos)
    const n = parseInt(buf.slice(posRef.pos + 1, end).toString(), 10)
    posRef.pos = end + 1
    return n
  }
  if (c === 'l') {
    posRef.pos++
    const arr = []
    while (buf[posRef.pos] !== 0x65 /* 'e' */) arr.push(bdecode(buf, posRef))
    posRef.pos++
    return arr
  }
  if (c === 'd') {
    posRef.pos++
    const obj = {}
    while (buf[posRef.pos] !== 0x65 /* 'e' */) {
      const k = bdecode(buf, posRef)
      const v = bdecode(buf, posRef)
      obj[k] = v
    }
    posRef.pos++
    return obj
  }
  // string: <len>:<bytes>
  const colon = buf.indexOf(0x3a /* ':' */, posRef.pos)
  const len = parseInt(buf.slice(posRef.pos, colon).toString(), 10)
  const s = buf.slice(colon + 1, colon + 1 + len).toString('utf8')
  posRef.pos = colon + 1 + len
  return s
}

// ── ng-protocol client ──────────────────────────────────────────────────────
class RtpEngineClient {
  constructor(host, port, timeoutMs = 4000) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
    this.sock = dgram.createSocket('udp4')
    this.pending = new Map()
    this.ready = new Promise((resolve) => {
      this.sock.bind(0, () => resolve())
    })
    this.sock.on('message', (msg) => this._onMessage(msg))
    this.sock.on('error', (err) => console.error('[rtpengine sock]', err.message))
  }

  _onMessage(msg) {
    // Format: "<cookie> <bencode-data>"
    const sep = msg.indexOf(0x20 /* ' ' */)
    if (sep === -1) return
    const cookie = msg.slice(0, sep).toString()
    const body = msg.slice(sep + 1)
    const pending = this.pending.get(cookie)
    if (!pending) return
    this.pending.delete(cookie)
    clearTimeout(pending.timeout)
    try {
      pending.resolve(bdecode(body))
    } catch (e) {
      pending.reject(e)
    }
  }

  send(cmd) {
    return this.ready.then(() => new Promise((resolve, reject) => {
      const cookie = crypto.randomBytes(8).toString('hex')
      const payload = Buffer.from(`${cookie} ${bencode(cmd)}`, 'utf8')
      const timeout = setTimeout(() => {
        if (this.pending.has(cookie)) {
          this.pending.delete(cookie)
          reject(new Error('rtpengine timeout'))
        }
      }, this.timeoutMs)
      this.pending.set(cookie, { resolve, reject, timeout })
      this.sock.send(payload, this.port, this.host, (err) => {
        if (err) {
          this.pending.delete(cookie)
          clearTimeout(timeout)
          reject(err)
        }
      })
    }))
  }

  /** Send a SIP UAC's SDP offer to rtpengine; returns rewritten SDP for the PBX side. */
  offer({ callId, fromTag, sdp }) {
    return this.send({
      command: 'offer',
      'call-id': callId,
      'from-tag': fromTag,
      sdp,
      // Replace origin & session connection so PBX sees rtpengine's addr
      replace: ['origin', 'session-connection'],
      // Force plain RTP on the PBX side (strip DTLS-SRTP)
      'transport-protocol': 'RTP/AVP',
      // Remove ICE candidates (PSTN doesn't speak ICE)
      ICE: 'remove',
      // Demux RTCP back into a separate port (legacy PBX expects this)
      'rtcp-mux': ['demux'],
      // Force PCMU codec for PBX side (most compatible with legacy PBX)
      codec: {
        transcode: ['PCMU'],
        strip: ['all'],
        offer: ['PCMU'],
      },
    })
  }

  /** Send the PBX's SDP answer; returns rewritten SDP for the SIP UAC side. */
  answer({ callId, fromTag, toTag, sdp }) {
    return this.send({
      command: 'answer',
      'call-id': callId,
      'from-tag': fromTag,
      'to-tag': toTag,
      sdp,
      replace: ['origin', 'session-connection'],
      // Force DTLS-SRTP back on the WebRTC side
      'transport-protocol': 'UDP/TLS/RTP/SAVPF',
      ICE: 'force',
      'rtcp-mux': ['offer'],
    })
  }

  delete({ callId, fromTag, toTag }) {
    const cmd = { command: 'delete', 'call-id': callId, 'from-tag': fromTag }
    if (toTag) cmd['to-tag'] = toTag
    return this.send(cmd)
  }

  ping() {
    return this.send({ command: 'ping' })
  }

  close() {
    try { this.sock.close() } catch {}
  }
}

module.exports = { RtpEngineClient, bencode, bdecode }
