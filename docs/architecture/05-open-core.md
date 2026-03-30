# Harmony — Open Source Model

> **License:** AGPL-3.0
> **Self-hosting:** Fully supported, no restrictions
> **SaaS:** [harmony.app](https://harmony.app) (managed hosting)

---

## Philosophy

Harmony is fully open source under AGPL-3.0. Anyone can use, modify, and self-host it for free with no feature restrictions.

The hosted SaaS (harmony.app) provides the same product with the added convenience of managed hosting and platform network features (server discovery, cross-server friends, push notifications) that naturally require a shared platform.

Self-hosters are allies, not lost revenue. They contribute code, report bugs, and evangelize the project.

---

## Self-Hosted vs SaaS

| Feature | Self-Hosted (Free) | SaaS (harmony.app) |
|---------|-------------------|---------------------|
| Text chat, voice, video | Yes | Yes |
| Roles & permissions | Yes | Yes |
| File uploads | Yes (configurable) | Yes (plan limits) |
| Custom emoji | Yes (configurable) | Yes |
| Message history | Unlimited | Plan-dependent |
| Server discovery directory | — | Yes (network feature) |
| Cross-server friends | — | Yes (network feature) |
| Push notifications | Self-managed | Built-in |
| Verified badges | — | Yes |

**Principle:** Self-hosting gives you the complete product. The SaaS adds network features that require a shared platform — not artificial restrictions.

---

## Technical Architecture

The public codebase is the full product. It defines traits (ports) for features like plan checking, which ship with an "always enabled" adapter for self-hosters.

The SaaS extends CE with billing, cosmetics, and network features via the same hexagonal architecture — different adapters for the same ports.

```
Public Repository (AGPL-3.0)
├── harmony-api/         Rust REST API (complete)
├── harmony-app/         Tauri desktop app (complete)
└── supabase/            Database migrations (complete)
```

See [`02-api-design.md`](02-api-design.md) and [`03-realtime.md`](03-realtime.md) for API and real-time architecture.

---

## Licensing

### Why AGPL-3.0?

- AGPL requires anyone running a modified version over a network to release their source code
- Prevents competitors from forking and offering a closed-source SaaS
- Self-hosters who don't modify the code are unaffected
- The Tauri desktop app is also AGPL-3.0 (behaves like GPL since it's not a network service)

### Contributing

By contributing to Harmony, you agree that your contributions are licensed under AGPL-3.0.
See [CONTRIBUTING.md](../../CONTRIBUTING.md).
