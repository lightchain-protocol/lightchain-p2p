# Builds

Installers ready to download, stored with Git LFS. Rebuild them from
`apps/chat` with `pnpm make` (macOS) and `pnpm make:windows` (Windows - this
one also builds on a Mac).

| Platform              | File                                     | How people install it                                                                      |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| macOS (Apple Silicon) | `macos/LightchainChat-0.1.0-arm64.dmg`   | Open it and drag the app into Applications once.                                           |
| Windows (64-bit)      | `windows/LightchainChat-Setup-0.1.0.exe` | Run it once: it installs the app with Start-menu and desktop shortcuts and an uninstaller. |

These builds are unsigned. On first launch macOS asks via System Settings →
Privacy & Security → **Open Anyway**, and Windows SmartScreen via **More info**
→ **Run anyway**.
