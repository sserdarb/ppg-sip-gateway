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
   - `GATEWAY_HOST=sip-gw.innovmar.cloud`
   - `PBX_HOST=90.158.44.140`
   - `PBX_PORT=5060`
   - `PBX_TRANSPORT=udp`
   - `LOG_SIP=0` (set `1` to debug)
5. Domain: `sip-gw.innovmar.cloud` with auto Let's Encrypt
6. Healthcheck path: `/health`
7. Deploy

## Client config (PPG Call Center)

In SIP/PBX settings:
- **WS Host:** `sip-gw.innovmar.cloud` (gateway, not PBX)
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

## AI voice concierge (extension 7000)

Calls to `AI_EXTENSION` (and DIDs routed `kind:"ai"`) are answered locally by
the concierge instead of being forwarded to the PBX.

```
caller RTP (PCMU)
  → VAD                      ai-agent.js
  → STT cascade              providers.js   Deepgram Nova-2 → Groq whisper-v3-turbo → self-hosted Whisper
  → intent router            intent-router.js  (regex first, then llama-3.1-8b)
  → main LLM (streaming)     providers.js   Groq 70B → Groq 8B → NVIDIA
      ├─ tool: check_availability → PPG /api/cc/availability → second pass speaks the real numbers
      └─ action: send_offer / transfer(department) → PPG /api/cc/ai-action
  → TTS cascade              providers.js   ElevenLabs Turbo → Cartesia Sonic → Groq Orpheus → Google
  → caller RTP (PCMU)
```

### Modular prompt set

| Layer | Where | Model | Job |
| --- | --- | --- | --- |
| 1 — Intent router | `intent-router.js` | `llama-3.1-8b-instant` | Classify the first utterance in ~250ms; selects the few-shot pack and catches escalations |
| 2 — Live agent | `ai-agent.js` `buildSystemPrompt()` | `llama-3.3-70b-versatile` | Runs the conversation; voice-optimised (1-2 sentences, one question per turn) |
| 3 — Post-call | PPG `lib/services/cc-voice-intelligence.ts` | Wide-context model via `callSmartAI` | Structured CRM record: intent, sentiment, dates, action items, QA score |

### Per-hotel context (from PPG `/api/cc/route`)

- `priceContext` / `hotelInfo` — real rooms, concepts, prices and property facts
- `sttVocabulary` — hotel jargon and proper nouns fed to the recogniser
  (Deepgram `keywords`, Whisper decoder `prompt`)
- `fewShot` — real successful exchanges keyed by intent, swapped in-memory as
  the router's verdict changes

### Provider cascades

Every provider self-skips when its API key is missing, so the order can list
all of them and you enable one by adding a key. Order is set with
`AI_STT_ORDER` / `AI_TTS_ORDER`; models with `AI_LLM_MODEL_GROQ` (alternates
worth A/B-ing: `qwen-2.5-72b-instruct`, `llama-3.1-70b-versatile`).

ElevenLabs and Cartesia need a per-account voice id per voice profile
(`ELEVENLABS_VOICE_MAP`, `CARTESIA_VOICE_MAP`); a profile with no id falls
through to the next provider, so they can be enabled one language at a time.

`GET /health` reports which providers actually have credentials — the first
thing to check when the AI "can't hear" or "won't speak".

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
  "pbx": "90.158.44.140:5060/udp",
  "activeAiCalls": 1,
  "providers": {
    "stt": { "order": ["deepgram","groq","whisper"], "active": ["groq","whisper"] },
    "tts": { "order": ["elevenlabs","cartesia","groq","google"], "active": ["groq","google"] },
    "llm": ["groq:llama-3.3-70b-versatile", "groq:llama-3.1-8b-instant"]
  }
}
```
