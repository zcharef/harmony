# Harmony — Development Roadmap

---

## Phase 0: Walking Skeleton (Done)

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

## Phase 1: Real-Time & Multi-User (Done)

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

## Phase 2: Roles, Permissions & DMs

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

## Phase 3: Voice, Files & Polish

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

## Phase 4: SaaS Launch

> **Goal:** Harmony Cloud goes live. First revenue.

### Product
- [ ] Harmony Cloud launch (harmony.app)
- [ ] Landing page and download page
- [ ] Free and Pro SaaS tiers
- [ ] Subscription integration
- [ ] Plan enforcement (member limits, storage, history)

### Infrastructure
- [ ] Production deployment
- [ ] Supabase Cloud project setup
- [ ] LiveKit Cloud or self-hosted LiveKit
- [ ] CDN for file delivery
- [ ] Push notification infrastructure
- [ ] Monitoring dashboards

### SaaS Network Features
- [ ] Server discovery directory (browse public servers)
- [ ] Cross-server friend system
- [ ] Verified badges

### Marketing
- [ ] Reddit launch (r/selfhosted, r/privacy, r/rust, r/opensource)
- [ ] Hacker News "Show HN"
- [ ] Comparison page (Harmony vs Discord vs Revolt vs Matrix)

### Milestone
Harmony Cloud is live. Users can sign up, create servers, and use the product. Self-hosted version is available on GitHub.

---

## Phase 4.5: Cosmetics & Boosts

> **Goal:** Individual and community monetization.

- [ ] Harmony+ subscription system (animated avatars, badges, themes)
- [ ] Server Boost system (community-funded server upgrades)
- [ ] Custom emoji system (global emoji for Harmony+ subscribers)
- [ ] Profile customization (banners, themes)

### Milestone
Users can subscribe to Harmony+. Communities can boost servers for better quality.

---

## Phase 5: Growth & Enterprise

> **Goal:** Expand the platform. Enterprise as secondary revenue.

- [ ] E2EE for DMs (Signal Protocol via libsignal)
- [ ] Web client (cloud.harmony.app)
- [ ] Mobile app (Tauri Mobile or React Native)
- [ ] Threads / forum channels
- [ ] Bot API (programmable bots, webhooks)
- [ ] Plugin/extension system
- [ ] Enterprise features: SSO (SAML/OIDC), audit logs, compliance export
- [ ] Enterprise self-hosted license system

---

## Priority Guidelines

1. **Text chat must be perfect before adding voice.** A laggy chat kills the product.
2. **Self-hosting must be easy.** One `docker compose up`. If it takes more than 5 minutes, you've lost the user.
3. **Don't build enterprise features before someone asks for it.** Revenue starts with SaaS, not licenses.
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
