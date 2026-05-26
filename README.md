# ppg-sip-gateway

SIP-over-WebSocket ↔ SIP-over-UDP translation gateway.

Lets browser/Electron softphones (JsSIP) connect to PBX systems that only
expose classic SIP (port 5060 UDP) without native WebSocket support.

## Architecture

```
JsSIP (browser/Electron)  ──wss──▶  ppg-sip-gateway  ──udp──▶  PBX
```

The gateway:
- Accepts `wss://<host>/ws` connections
- Creates a dedicated UDP socket per WS session
- Rewrites `Via` header — adds the gateway's address so PBX replies come back
- Rewrites `Contact` header — so in-dialog requests reach the gateway
- Recomputes `Content-Length` after edits

## Deploy (Coolify)

1. Add new Coolify Application from GitHub: `sserdarb/ppg-sip-gateway`
2. Buildpack: **Nixpacks** (auto-detected)
3. Port: **8080** (Coolify maps to 443 with auto-TLS)
4. Set environment variables:
   - `GATEWAY_HOST=sip-gw.bluedreamsresort.com`
   - `PBX_HOST=90.158.44.140`
   - `PBX_PORT=5060`
   - `PBX_TRANSPORT=udp`
   - `LOG_SIP=0` (set `1` to debug)
5. Domain: `sip-gw.bluedreamsresort.com` with auto Let's Encrypt
6. Healthcheck path: `/health`
7. Deploy

## Client config (PPG Call Center)

In SIP/PBX settings:
- **WS Host:** `sip-gw.bluedreamsresort.com` (gateway, not PBX)
- **WS Port:** `443`
- **WS Path:** `/ws`
- **WSS:** ON
- **Domain (SIP URI):** `90.158.44.140` (real PBX, used in SIP URI)
- **Account / Password:** as provided by Tescom

## Local development

```bash
npm install
cp .env.example .env
node server.js
```

Then connect a SIP client to `ws://localhost:8080/ws`.

## Limitations

- UDP transport only (no TCP/TLS to PBX yet)
- Media (RTP) goes directly browser ↔ PBX via WebRTC ICE/STUN — gateway
  does NOT proxy media. If PBX is behind strict NAT or in private network,
  add an RTP proxy (e.g. rtpengine).
- Single Via depth assumed for response-time stripping.
- No SIP transaction state tracked — relies on PBX/client retransmits.

## Health endpoint

```
GET /health
{
  "ok": true,
  "uptime": 12345,
  "activeSessions": 2,
  "totalSessions": 47,
  "totalToPbx": 1834,
  "totalToClient": 1601,
  "pbx": "90.158.44.140:5060/udp"
}
```
