<p align="center"><img src="docs/media/cover.svg" alt="Quiet Companion — a macOS desktop pet, optional real-time avatar and AI computer tasks. Original illustration, not a screenshot." width="100%"></p>

# Quiet Companion · 栖伴

[![Project harness](https://github.com/jamiu99/quiet-companion-macos/actions/workflows/check.yml/badge.svg)](https://github.com/jamiu99/quiet-companion-macos/actions/workflows/check.yml) · [MIT License](LICENSE)

**A little presence on your Mac. An agent that can help get things done.**

An Electron / React / TypeScript desktop companion combining a local pet, an optional Vidu real-time avatar, and an isolated pi coding-agent process for computer tasks.

[中文](README.md) · [API setup](docs/API_AUTH.md) · [Architecture guide](docs/PROJECT_GUIDE.md) · [Security](SECURITY.md) · [Maintainer launch checklist](docs/LAUNCH.md)

> **MIT open source / pre-release.** No officially signed/notarized release is available. This repository excludes the RTC SDK and earlier generated media. The cover is an original illustration, not a running-app screenshot.

## What it does

- **Local desktop pet:** move, resize, pin, switch desktop layers, or tuck it against the screen edge. No service key is required for the bundled procedural demo.
- **AI computer tasks:** text/file processing, shell and macOS automation through a separate agent-host process. Requires your own compatible service key; service usage may cost money.
- **Optional real-time companion:** remote voice/video and task-progress narration through Vidu + a separately supplied AliRTC SDK.
- **Characters:** your own images, idle videos, personality and voice; optional paid media generation.
- **PKCE authorization:** TokenDance browser authorization with S256 PKCE and a loopback callback. Full newly issued keys stay out of the settings renderer. Manual entry is also supported.

Local idle presentation is offline. Model conversations, generated media and real-time avatars are **not** fully local.

## Run from source

Requirements: macOS, Node.js 24 and npm. The current packaging target is Apple Silicon / arm64.

```bash
git clone https://github.com/jamiu99/quiet-companion-macos.git
cd quiet-companion-macos
npm ci
npm run check  # Build + unit tests + real Electron/WebGL regression, without paid service calls
npm run dev
```

Configure the agent in Settings → Agent. This repository has a stable authorization attribution URL; fork publishers must update `publication.json.repositoryUrl` before distributing their version. Quit older versions before starting: normal startup may use your existing profile. Use `npm run check` for offline validation, not a live chat.

For text-only usage, **turn off “发消息自动连接” (auto-connect on message)** before entering Vidu credentials. Once real-time dependencies are configured, the default first-message behavior may start a billable session.

Real-time mode is optional. Follow [RTC setup](docs/RTC_SETUP.md) to install an SDK you are entitled to use. Missing or mismatched SDK files are rejected **before** a new paid create request. Text-agent and idle modes remain available.

## Engineering choices

- Main-process-owned credentials, validated IPC, sandboxed rendering, private agent model metadata and JSON-lines communication.
- Chroma-key confidence + background connectivity + portrait-relative framing checks. Bad frames fall back to standby rather than continually resizing the character.
- Offline tests compile real GLSL, inspect alpha, decode/seek video and exercise browser settings, PKCE callbacks and local-file access boundaries.
- Reproducible geometric demo artwork; no private screenshots, external fonts or generated-person footage in the public export.

## Limits that matter

- Keys are currently in a **0600 plaintext configuration**, not encrypted with macOS Keychain.
- The agent can run shell/AppleScript and access files outside its workspace. There is no per-tool approval boundary; it is not a sandbox for untrusted instructions.
- Visual fallback does not stop a paid session. Disconnect explicitly; local closure is not a provider billing receipt.
- Live OAuth compatibility, signing/notarization, fresh-machine installation and broader GUI validation remain pending. Offline tests do not establish any of these.
- Never attach `.env`, user profiles, full logs or private recordings to public issues.

See [test harness](docs/HARNESS.md), [roadmap](docs/ROADMAP.md), [contributing](CONTRIBUTING.md) and [third-party notices](THIRD_PARTY_NOTICES.md). Project source, documentation and bundled original demo artwork are [MIT licensed](LICENSE), with existing attribution preserved. Third-party dependencies retain their own licenses. The unbundled RTC SDK, model services and user media are not relicensed by this project.
