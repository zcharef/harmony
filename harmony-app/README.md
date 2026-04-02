# Harmony App

Web app + Tauri desktop client for Harmony — Discord's UX with Signal's principles.

- **Web:** React 19 SPA (Vite) — servers, channels, DMs, invites, moderation
- **Desktop:** Same codebase wrapped in [Tauri 2](https://tauri.app/) — adds E2EE for DMs via [vodozemac](https://github.com/matrix-org/vodozemac)

## Development

```bash
pnpm install
just dev          # Web dev server (port 1420)
just tauri dev    # Desktop app with E2EE
just wall         # Full quality wall
```

See the [root README](../README.md) for full setup instructions.
