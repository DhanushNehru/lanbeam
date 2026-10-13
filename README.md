<div align="center">

# ⚡ LanBeam

**Drop files to any device on your network. No accounts, no cloud, no trace.**

[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)
[![WebRTC](https://img.shields.io/badge/transport-WebRTC%20DataChannel-6c8cff.svg)](https://webrtc.org)

<!-- Record a 20-second demo: phone → laptop transfer, and drop the GIF here -->
<!-- ![LanBeam demo](demo.gif) -->

[How it works](#how-it-works) · [60-second start](#60-second-start) · [Privacy](#privacy) · [vs. alternatives](#vs-alternatives)

</div>

---

Your files should not take a detour through someone else's server to travel ten feet across your room.

LanBeam sends files **directly between devices** over an encrypted WebRTC connection. The server in this repo only introduces the two devices to each other — it never sees, stores, or logs a single byte of your files.

## ✨ Features

- 📤 **Multi-file drag & drop** with live progress, speed, and per-file download links
- 🔐 **End-to-end encrypted** — WebRTC DataChannels are encrypted with DTLS by default
- 🙈 **Zero-knowledge server** — signaling only; rooms auto-expire after 30 minutes
- 📱 **Phone-friendly** — receiver joins via QR code or a 6-character code, no app install
- 💬 **Send-a-note** — fire a short text message alongside your files
- 🪶 **No build step** — vanilla JS, one tiny Node server, one npm dependency (`ws`)
- 🌐 **Works beyond your LAN** — STUN-assisted NAT traversal for transfers over the internet

## 🚀 60-second start

```bash
git clone https://github.com/DhanushNehru/lanbeam.git
cd lanbeam
npm install
npm start
```

Open the printed **Network URL** (e.g. `http://192.168.1.5:3000`) on both devices:

1. **Sender** → *Send files* → pick files → a 6-character code + QR appears
2. **Receiver** → *Receive files* → enter the code (or scan the QR) → *Accept*
3. Files fly device-to-device, encrypted. Done.

> Want it on the internet, not just your LAN? Deploy the same `server.js` anywhere Node runs (a $4 VPS, Fly.io, Railway…) — the privacy guarantees don't change, because files still never touch the server.

## 🔒 Privacy

| | LanBeam | Typical "free" transfer sites |
|---|---|---|
| Files pass through a server | ❌ Never | ✅ Yes — that's their business model |
| Account required | ❌ | ✅ Usually |
| File size limits / expiry upsells | ❌ | ✅ |
| Metadata logged | ❌ (rooms are in-memory, auto-expire) | ✅ |
| Open source, auditable | ✅ | ❌ |

Threat model in one line: the only thing an attacker running the signaling server can learn is *that* two devices connected — never *what* they sent.

## 🛠 How it works

```
 Sender (browser)                    Signaling server (Node)              Receiver (browser)
      │                                        │                                   │
      │── create room ────────────────────────▶│                                   │
      │◀──────────── 6-char code ──────────────│                                   │
      │                                        │◀────────── join(code) ────────────│
      │◀──────────── peer-joined ───────────────│                                   │
      │── SDP offer ──────────────────────────▶│── SDP offer ─────────────────────▶│
      │                                        │◀────────── SDP answer ───────────│
      │◀──────────── SDP answer ───────────────│                                   │
      │  ═══════════ encrypted WebRTC DataChannel (DTLS) ═══════════════════════▶ │
      │  ─────────────── file chunks (16 KB) ──────────────────────────────────▶ │
```

1. **Signaling** (WebSocket): exchange of SDP offers/answers and ICE candidates, keyed by room code.
2. **Transfer** (WebRTC DataChannel): chunked binary transfer with backpressure, progress, and reassembly — entirely peer-to-peer.

## 🗺 Roadmap

- [ ] Pairing via WebRTC mDNS — zero server at all on the same network
- [ ] Folder transfer (zip on the fly)
- [ ] Resume interrupted transfers
- [ ] E2E-encrypted text chat alongside files
- [ ] Desktop tray app (Tauri)

Have an idea? [Open an issue](https://github.com/DhanushNehru/lanbeam/issues) — good ideas get built fast here.

## 🤝 Contributing

PRs welcome. Keep it dependency-light and privacy-first:

```bash
npm install
npm start   # http://localhost:3000
```

No linter, no framework, no build — if your change needs a bundler, it's probably too big.

## 📄 License

MIT © Dhanush Nehru — see [LICENSE](LICENSE).

---

<div align="center">

If LanBeam saved you from uploading a file to a sketchy site, consider giving it a ⭐ — it helps others find it.

</div>
