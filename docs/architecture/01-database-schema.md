# Harmony — Database Schema

> **Engine:** PostgreSQL 17 (via Supabase)
> **Migrations:** Supabase CLI (`supabase migration new`)
> **ORM:** SQLx (compile-time checked queries)
> **Auth:** Supabase Auth (`auth.users` managed by GoTrue)

---

## 1. Schema Overview

```
auth.users (Supabase-managed)
    │
    ▼
public.profiles ──────────────────────────┐
    │                                      │
    ▼                                      │
public.servers                             │
    │                                      │
    ├── public.server_members ◄────────────┘
    │       │
    │       └── public.member_roles
    │
    ├── public.roles
    │
    ├── public.categories
    │       │
    │       └── public.channels
    │               │
    │               ├── public.messages
    │               │       │
    │               │       └── public.message_attachments
    │               │
    │               └── public.channel_permission_overrides
    │
    └── public.invites
```

---

## 2. Table Definitions

### 2.1 `profiles`

User profile — synced from `auth.users` via trigger. Public-facing data only.

```sql
CREATE TABLE public.profiles (
    -- PK = Supabase auth.users.id (no separate sequence)
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    display_name TEXT,
    avatar_url  TEXT,
    status      TEXT CHECK (status IN ('online', 'idle', 'dnd', 'offline')) DEFAULT 'offline',
    custom_status TEXT,                -- "Playing Elden Ring"
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Uniqueness
    CONSTRAINT profiles_username_unique UNIQUE (username),
    -- Username format: 3-32 chars, lowercase alphanumeric + underscores
    CONSTRAINT profiles_username_format CHECK (username ~ '^[a-z0-9_]{3,32}$')
);

-- Index for username lookups (login, search, @mentions)
CREATE INDEX idx_profiles_username ON public.profiles (username);
```

**Sync trigger:** When a user signs up via Supabase Auth, a database trigger copies `id` into `profiles` with a generated username. The user can update their profile later via the API.

### 2.2 `servers`

A "server" (guild) — the top-level container for channels and members.

```sql
CREATE TABLE public.servers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    icon_url    TEXT,                   -- Supabase Storage path
    owner_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    is_public   BOOLEAN NOT NULL DEFAULT false,  -- Discoverable in server directory
    member_count INT NOT NULL DEFAULT 1,         -- Denormalized for performance
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT servers_name_length CHECK (char_length(name) BETWEEN 2 AND 100)
);

CREATE INDEX idx_servers_owner ON public.servers (owner_id);
```

### 2.3 `server_members`

Junction table — which users belong to which servers.

```sql
CREATE TABLE public.server_members (
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    nickname    TEXT,                              -- Server-specific display name
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    muted       BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (server_id, user_id)
);

CREATE INDEX idx_server_members_user ON public.server_members (user_id);
```

### 2.4 `roles`

Server roles with permission bitmasks. See [04-auth-and-permissions.md](./04-auth-and-permissions.md) for the bitmask definition.

```sql
CREATE TABLE public.roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT,                              -- Hex color (#FF5733)
    position    INT NOT NULL DEFAULT 0,            -- Higher = more authority
    permissions BIGINT NOT NULL DEFAULT 0,         -- Bitmask (see permissions doc)
    is_default  BOOLEAN NOT NULL DEFAULT false,    -- Auto-assigned on join (@everyone)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Only one @everyone role per server
    CONSTRAINT roles_one_default_per_server UNIQUE (server_id, is_default)
        -- Partial unique index is better, see below
);

-- Partial unique index: only one role where is_default = true per server
CREATE UNIQUE INDEX idx_roles_one_default
    ON public.roles (server_id) WHERE is_default = true;

CREATE INDEX idx_roles_server ON public.roles (server_id);
```

### 2.5 `member_roles`

Junction: which members have which roles.

```sql
CREATE TABLE public.member_roles (
    server_id   UUID NOT NULL,
    user_id     UUID NOT NULL,
    role_id     UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,

    PRIMARY KEY (server_id, user_id, role_id),
    FOREIGN KEY (server_id, user_id) REFERENCES public.server_members(server_id, user_id) ON DELETE CASCADE
);
```

### 2.6 `categories`

Channel grouping within a server (like Discord's categories).

```sql
CREATE TABLE public.categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    position    INT NOT NULL DEFAULT 0,

    CONSTRAINT categories_name_length CHECK (char_length(name) BETWEEN 1 AND 100)
);

CREATE INDEX idx_categories_server ON public.categories (server_id);
```

### 2.7 `channels`

Text/voice/forum channels within a server.

```sql
CREATE TYPE channel_type AS ENUM ('text', 'voice', 'forum');

CREATE TABLE public.channels (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id    UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    category_id  UUID REFERENCES public.categories(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    topic        TEXT,
    channel_type channel_type NOT NULL DEFAULT 'text',
    position     INT NOT NULL DEFAULT 0,
    is_nsfw      BOOLEAN NOT NULL DEFAULT false,
    slowmode_seconds INT NOT NULL DEFAULT 0,       -- 0 = disabled
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Channel name format: lowercase, hyphens, 1-100 chars
    CONSTRAINT channels_name_format CHECK (name ~ '^[a-z0-9-]{1,100}$')
);

CREATE INDEX idx_channels_server ON public.channels (server_id);
```

### 2.8 `channel_permission_overrides`

Per-channel permission overrides for specific roles (like Discord's channel permissions).

```sql
CREATE TABLE public.channel_permission_overrides (
    channel_id  UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    role_id     UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    allow       BIGINT NOT NULL DEFAULT 0,  -- Bitmask: explicitly allowed
    deny        BIGINT NOT NULL DEFAULT 0,  -- Bitmask: explicitly denied

    PRIMARY KEY (channel_id, role_id)
);
```

**Resolution order:** Server role permissions → Channel overrides (deny wins over allow).

### 2.9 `messages`

Chat messages.

```sql
CREATE TABLE public.messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    author_id   UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    content     TEXT,                              -- Markdown text (nullable for attachment-only)
    reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    is_edited   BOOLEAN NOT NULL DEFAULT false,
    is_pinned   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,

    -- At least content or an attachment must exist (enforced at API level, not DB)
    CONSTRAINT messages_content_length CHECK (content IS NULL OR char_length(content) <= 4000)
);

-- Primary query: messages in a channel, ordered by time (pagination)
CREATE INDEX idx_messages_channel_created
    ON public.messages (channel_id, created_at DESC);

-- Pinned messages lookup
CREATE INDEX idx_messages_pinned
    ON public.messages (channel_id) WHERE is_pinned = true;
```

### 2.10 `message_attachments`

Files attached to messages (stored in Supabase Storage).

```sql
CREATE TABLE public.message_attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    file_name   TEXT NOT NULL,
    file_size   BIGINT NOT NULL,          -- Bytes
    mime_type   TEXT NOT NULL,
    storage_path TEXT NOT NULL,            -- Supabase Storage path
    width       INT,                       -- For images/videos
    height      INT,

    CONSTRAINT attachments_file_size CHECK (file_size > 0 AND file_size <= 52428800) -- 50MB max
);

CREATE INDEX idx_attachments_message ON public.message_attachments (message_id);
```

### 2.11 `invites`

Server invite links.

```sql
CREATE TABLE public.invites (
    code        TEXT PRIMARY KEY,                  -- Short code (e.g., "abc123")
    server_id   UUID NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    creator_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    max_uses    INT,                               -- NULL = unlimited
    use_count   INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,                       -- NULL = never
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT invites_code_format CHECK (code ~ '^[a-zA-Z0-9]{6,12}$')
);

CREATE INDEX idx_invites_server ON public.invites (server_id);
```

---

## 3. Direct Messages (Phase 2)

DMs are modeled as special "servers" with exactly 2 members, no roles, and a single text channel. This keeps the architecture uniform.

```sql
-- DM conversations reuse the server/channel model
-- A DM "server" has:
--   is_dm = true (add column to servers table in Phase 2 migration)
--   Exactly 2 server_members
--   Exactly 1 channel (type = 'text')
--   No roles, no categories
```

**Why not a separate `dm_conversations` table?** Uniformity. The same message query, Supabase Realtime subscription, and permission logic works for both servers and DMs. Less code, fewer bugs.

---

## 4. Row Level Security (RLS)

Every table must have RLS enabled. Policies ensure users can only access data they're authorized to see.

### Key Policies

```sql
-- profiles: anyone can read, only owner can update
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_all" ON public.profiles
    FOR SELECT USING (true);

CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (id = auth.uid());

-- messages: only server members can read/write
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select_member" ON public.messages
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            WHERE c.id = messages.channel_id
            AND sm.user_id = auth.uid()
        )
    );

CREATE POLICY "messages_insert_member" ON public.messages
    FOR INSERT WITH CHECK (
        author_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.server_members sm
            JOIN public.channels c ON c.server_id = sm.server_id
            WHERE c.id = channel_id
            AND sm.user_id = auth.uid()
        )
    );
```

> **Note:** RLS policies are a safety net. The Rust API performs its own authorization checks. RLS prevents bugs in the API from leaking data.

---

## 5. Denormalization Strategy

| Field | Table | Why |
|-------|-------|-----|
| `member_count` | `servers` | Avoids COUNT(*) on every server list query |
| `use_count` | `invites` | Avoids COUNT(*) join on invite usage |

Denormalized fields are updated via the Rust API (not triggers) to keep logic in the application layer.

---

## 6. Migration Naming Convention

```
supabase/migrations/
├── 20260215000000_create_profiles.sql
├── 20260215000001_create_servers.sql
├── 20260215000002_create_server_members.sql
├── 20260215000003_create_roles.sql
├── 20260215000004_create_member_roles.sql
├── 20260215000005_create_categories.sql
├── 20260215000006_create_channels.sql
├── 20260215000007_create_channel_permission_overrides.sql
├── 20260215000008_create_messages.sql
├── 20260215000009_create_message_attachments.sql
├── 20260215000010_create_invites.sql
├── 20260215000011_enable_rls.sql
├── 20260215000012_create_profile_sync_trigger.sql
```

All migrations are idempotent (`IF NOT EXISTS`). No `DROP` statements in production.
