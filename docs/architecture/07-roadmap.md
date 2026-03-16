# Harmony — Development Roadmap

---

## Phase 0: Walking Skeleton (Current → Week 2)

> **Goal:** A user can sign up, create a server, and send a text message.

### Backend (harmony-api)
- [ ] Database migrations: `profiles`, `servers`, `server_members`, `channels`, `messages`
- [ ] Profile sync trigger (auth.users → profiles)
- [ ] `POST /v1/auth/me` — Get or create profile after login
- [ ] `GET /v1/profiles/me` — Get own profile
- [ ] `POST /v1/servers` — Create server (+ default role, #general channel)
- [ ] `GET /v1/servers` — List user's servers
- [ ] `GET /v1/servers/{id}/channels` — List channels
- [ ] `POST /v1/channels/{id}/messages` — Send message
- [ ] `GET /v1/channels/{id}/messages` — List messages (cursor pagination)
- [ ] RLS policies for all tables

### Frontend (harmony-app)
- [ ] Supabase Auth integration (login/signup screen)
- [ ] Server list sidebar (left rail)
- [ ] Channel list sidebar
- [ ] Message list (virtualized with react-virtuoso)
- [ ] Message input (basic text, enter to send)
- [ ] Connect generated API client to real endpoints
- [ ] Remove mock data (`lib/data.ts`)

### DevOps
- [ ] Local dev works end-to-end: `supabase start` → `just dev` → `just tauri-dev`

### Milestone
You can open the Tauri app, log in, create a server, and chat with yourself in #general.

---

## Phase 1: Real-Time & Multi-User (Weeks 3–5)

> **Goal:** Two users can chat in real-time.

### Backend
- [ ] Supabase Realtime RLS policies (ensure messages table changes are push-safe)
- [ ] `PATCH /v1/messages/{id}` — Edit message
- [ ] `DELETE /v1/messages/{id}` — Delete message
- [ ] Invite system: `POST /v1/servers/{id}/invites`, `POST /v1/servers/{id}/members` (join via invite)

### Frontend
- [ ] Supabase Realtime subscriptions (Postgres Changes for messages)
- [ ] Live message updates (cache mutation via TanStack Query)
- [ ] Typing indicator via Supabase Broadcast ("User is typing...")
- [ ] Presence system via Supabase Presence (online/idle/offline)
- [ ] Invite link generation + join flow
- [ ] Optimistic UI for sent messages (show immediately, gray until confirmed)
- [ ] Message edit/delete UI

### Milestone
You invite a friend. They join your server. You chat in real-time. Messages appear instantly.

---

## Phase 2: Roles, Permissions & DMs (Weeks 6–9)

> **Goal:** Server administration and private messaging.

### Backend
- [ ] Roles CRUD (`POST/PATCH/DELETE /v1/servers/{id}/roles`)
- [ ] Permission bitmask computation + enforcement middleware
- [ ] Channel permission overrides
- [ ] Role assignment (`PUT/DELETE /v1/servers/{id}/members/{userId}/roles/{roleId}`)
- [ ] Member management: kick, ban
- [ ] DM "servers" (2-member, single channel)
- [ ] Presence system (online/idle/dnd/offline via Supabase Realtime Presence)
- [ ] User profile CRUD (`PATCH /v1/profiles/me`)
- [ ] Categories CRUD

### Frontend
- [ ] Server settings page (name, icon, roles)
- [ ] Role management UI (create, reorder, set permissions)
- [ ] Channel permission overrides UI
- [ ] Member list with roles/colors
- [ ] Kick/ban actions
- [ ] DM conversations (sidebar section)
- [ ] User profile modal (click avatar → see profile)
- [ ] Presence indicators (green dot = online)
- [ ] Category management (drag & drop reorder)

### Milestone
Server owners can manage roles and permissions. Users can DM each other. Online status is visible.

---

## Phase 3: Voice, Files & Polish (Weeks 10–14)

> **Goal:** Feature parity with a basic Discord experience.

### Backend
- [ ] LiveKit integration: token generation, room management
- [ ] `POST /v1/channels/{id}/voice/join` — Get LiveKit token
- [ ] File upload: `POST /v1/channels/{id}/attachments` → Supabase Storage
- [ ] Message attachments (images, files with metadata)
- [ ] Server icon upload
- [ ] Avatar upload
- [ ] Pin messages
- [ ] Message search (full-text search via Postgres `tsvector`)
- [ ] Server discovery (public servers directory)
- [ ] Rate limiting per endpoint (not just global)

### Frontend
- [ ] Voice channel UI (join/leave/mute/deafen)
- [ ] LiveKit JS SDK integration
- [ ] Push-to-Talk (Tauri global hotkey)
- [ ] Noise suppression toggle
- [ ] Screen sharing
- [ ] File upload in message input (drag & drop, paste, button)
- [ ] Image/file preview in messages
- [ ] Markdown rendering (code blocks with syntax highlighting)
- [ ] Rich embeds (URL previews — og:image, og:title)
- [ ] Pinned messages panel
- [ ] Server search / public directory
- [ ] Notification system (Tauri native notifications)
- [ ] System tray icon
- [ ] Unread indicators (bold channel name, mention badge)

### DevOps
- [ ] Docker Compose for self-hosting (with LiveKit)
- [ ] CI/CD pipeline (GitLab CI)
- [ ] Automated builds for Tauri (Linux, macOS, Windows)

### Milestone
Public beta. Users can text chat, voice chat, share files, and manage servers. Self-hosting works via Docker Compose.

---

## Phase 4: SaaS Launch & Monetization (Weeks 15–20)

> **Goal:** Revenue starts flowing.

### Product
- [ ] Harmony Cloud launch (hosted SaaS)
- [ ] Stripe/LemonSqueezy integration for subscriptions
- [ ] Free tier limits (1 server, 100 members, 7-day history)
- [ ] Pro plan ($5/server/month)
- [ ] Usage metering (storage, member count)
- [ ] Landing page (harmony.app)
- [ ] Tauri app download page

### Infrastructure
- [ ] Kubernetes deployment (Helm charts exist)
- [ ] Supabase Cloud project setup
- [ ] LiveKit Cloud or self-hosted LiveKit
- [ ] CDN for file delivery
- [ ] Monitoring dashboards

### Marketing
- [ ] Reddit launch posts (r/selfhosted, r/privacy, r/rust, r/technology)
- [ ] Hacker News "Show HN" post
- [ ] GitHub README with screenshots/GIF
- [ ] Comparison page: Harmony vs Discord vs Revolt vs Matrix

### Milestone
Harmony Cloud is live. Users can sign up, create servers, and pay for Pro plans. Self-hosted version is available on GitHub.

---

## Phase 5: Enterprise & Growth (Months 6+)

> **Goal:** Enterprise revenue and community growth.

- [ ] `harmony-enterprise` crate (SSO, audit logs, compliance)
- [ ] SAML/OIDC integration for SSO
- [ ] Advanced audit logs (who did what, when)
- [ ] Data retention policies (auto-delete old messages)
- [ ] E2EE for DMs (Signal Protocol via libsignal)
- [ ] Web client (cloud.harmony.app) — for users who don't want to install the desktop app
- [ ] Mobile app (Tauri Mobile or React Native)
- [ ] Threads / forum channels
- [ ] Bot API (programmable bots, webhooks)
- [ ] Custom emoji system
- [ ] Patron tier (animated avatars, badges)
- [ ] Plugin/extension system

---

## Priority Guidelines

1. **Text chat must be perfect before adding voice.** A laggy chat kills the product.
2. **Self-hosting must be easy.** One `docker compose up`. If it takes more than 5 minutes, you've lost the user.
3. **Don't build EE before someone asks for it.** Revenue starts with SaaS, not enterprise licenses.
4. **Ship weekly.** Small, frequent releases beat big, delayed ones.
5. **Dogfood it.** Use Harmony for your own dev communication as soon as Phase 1 is complete.

---

## Tech Debt Budget

Reserve 20% of each phase for:
- Refactoring as patterns emerge
- Performance optimization (especially message rendering)
- Security hardening
- Documentation

Do NOT accumulate tech debt through Phases 0-2. The foundation must be solid before scaling.
