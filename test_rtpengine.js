// rtpengine ng-protocol ping test
const dgram = require('dgram')
const crypto = require('crypto')

const HOST = '76.13.0.113'
const PORT = 22222

const cookie = crypto.randomBytes(8).toString('hex')
const msg = `${cookie} d7:command4:pinge`

const sock = dgram.createSocket('udp4')
sock.on('message', (data) => {
  console.log('← Response:', data.toString())
  sock.close()
})
sock.send(msg, PORT, HOST, (err) => {
  if (err) { console.error('Send err:', err); sock.close(); return }
  console.log('→ Sent:', msg)
})
setTimeout(() => { console.log('TIMEOUT'); sock.close() }, 3000)
