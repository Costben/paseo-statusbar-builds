# paseo-statusbar-builds

Automated CI that rebuilds [getpaseo/paseo](https://github.com/getpaseo/paseo) Android APK, macOS (arm64), and Windows (x64) with edge-to-edge status bar fix, Kimi Code native support, and auto-update hijacking.

### 📦 [👉 Releases / 点击直达最新构建下载 (APK / macOS / Windows)](https://github.com/Costben/paseo-statusbar-builds/releases)

---

## Artifacts & Features

| Platform | Artifact | Enhancements |
|---|---|---|
| **Android** | `paseo-<ver>-statusbar-fixed.apk` | Edge-to-edge status & nav bar fix, composer badges, Universal 4-ABI |
| **macOS** | `Paseo-<ver>-arm64.dmg`<br>`Paseo-<ver>-arm64.zip` | Kimi Code native daemon integration, context window & goal pills, self-update hijack |
| **Windows** | `Paseo-Setup-<ver>-x64.exe` | Kimi Code native integration, background hidden console (`windowsHide`), self-update hijack |

> This is a **standalone build repo**, not a source fork. At build time it checks out an upstream tag, injects patches, and compiles without storing upstream code.

---

## 📖 Documentation Index

To keep this main page lightweight and mobile-friendly, detailed guides and references have been organized into dedicated sub-pages:

- [🚀 **Getting Started & Setup**](docs/getting-started.md)  
  Repository setup, permissions configuration, first build, and artifact verification.
- [🛠 **Patches & Technical Specifications**](docs/patches.md)  
  Status bar injection, Kimi native desktop series (ACP usage, goal tracking, compaction, pills, etc.).
- [🔄 **CI Workflows & Architecture**](docs/workflows.md)  
  Watcher & dispatch flow, stage matrix, patch vs upstream rebuild triggers, concurrency control.
- [🖥 **Desktop Auto-Updates & Code Signing**](docs/desktop-updates.md)  
  GitHub provider hijack, macOS self-signed certificates & trust, Hardened Runtime entitlements.
- [🔧 **Maintenance & Configuration Knobs**](docs/maintenance.md)  
  Troubleshooting common build/patch failures, schedule cron settings, rebuild flags, timeouts.

---

## Development

- Repository changes follow the **remote-only convention**. See [`AGENTS.md`](AGENTS.md).
- Validate patch changes using `patch-verify.yml` in CI.
