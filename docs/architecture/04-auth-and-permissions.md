# Harmony — Auth & Permissions (RBAC)

> **Auth Provider:** Supabase Auth (GoTrue)
> **Token Format:** JWT (HS256)
> **Permission Model:** Bitmask-based RBAC (like Discord)

---

## 1. Authentication Flow

```
┌──────────────┐    1. Login (email/password)     ┌──────────────┐
│  Tauri App   │ ──────────────────────────────►   │  Supabase    │
│  (React)     │    2. JWT (access + refresh)      │  Auth        │
│              │ ◄──────────────────────────────   │  (GoTrue)    │
└──────┬───────┘                                   └──────────────┘
       │
       │ 3. Bearer <jwt> on every request
       ▼
┌──────────────┐    4. Verify JWT signature        ┌──────────────┐
│  Harmony     │    (using SUPABASE_JWT_SECRET)     │  Supabase    │
│  Rust API    │ ──────────────────────────────►   │  Postgres    │
│              │    5. Query data with user_id      │              │
└──────────────┘                                   └──────────────┘
```

### Steps

1. **Client** calls Supabase Auth SDK directly (`supabase.auth.signInWithPassword()`)
2. **Supabase** returns a JWT `access_token` (1h TTL) + `refresh_token`
3. **Client** stores tokens in memory (Zustand) — NOT localStorage (XSS risk in web, fine in Tauri)
4. **Client** sends JWT as `Authorization: Bearer <token>` on every API call
5. **Rust API** verifies JWT signature using the shared `SUPABASE_JWT_SECRET` (HS256)
6. **Rust API** extracts `sub` (user UUID) from the JWT payload — this is the authenticated `UserId`

### Token Refresh

- Client refreshes token via Supabase SDK when it expires (automatic)
- If refresh fails (user banned, account deleted), redirect to login

### First Login — Profile Creation

When a user's JWT is valid but no `profiles` row exists:
1. Client calls `POST /v1/auth/me`
2. API creates a profile with a generated username (e.g., `user_a1b2c3`)
3. User can update their username later via `PATCH /v1/profiles/me`

---

## 2. Permission Bitmask

Permissions are stored as a 64-bit integer (`BIGINT` in Postgres, `i64` in Rust). Each bit represents one permission.

### Permission Definitions

```rust
// domain/models/permissions.rs

bitflags::bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct Permissions: i64 {
        // ── General ──
        const VIEW_CHANNEL       = 1 << 0;   // See channels and read messages
        const MANAGE_CHANNELS    = 1 << 1;   // Create/edit/delete channels
        const MANAGE_ROLES       = 1 << 2;   // Create/edit/delete roles
        const MANAGE_SERVER      = 1 << 3;   // Edit server name, icon, settings
        const CREATE_INVITE      = 1 << 4;   // Generate invite links

        // ── Messaging ──
        const SEND_MESSAGES      = 1 << 10;  // Send text messages
        const ATTACH_FILES       = 1 << 11;  // Upload files
        const EMBED_LINKS        = 1 << 12;  // Auto-embed URLs
        const MENTION_EVERYONE   = 1 << 13;  // Use @everyone / @here
        const MANAGE_MESSAGES    = 1 << 14;  // Delete/pin others' messages
        const READ_MESSAGE_HISTORY = 1 << 15; // Read messages sent before joining

        // ── Members ──
        const KICK_MEMBERS       = 1 << 20;  // Remove members
        const BAN_MEMBERS        = 1 << 21;  // Ban members
        const MANAGE_MEMBERS     = 1 << 22;  // Edit nicknames, assign roles

        // ── Voice ──
        const CONNECT            = 1 << 30;  // Join voice channels
        const SPEAK              = 1 << 31;  // Transmit audio
        const MUTE_MEMBERS       = 1 << 32;  // Mute others in voice
        const DEAFEN_MEMBERS     = 1 << 33;  // Deafen others in voice
        const MOVE_MEMBERS       = 1 << 34;  // Move members between voice channels

        // ── Admin ──
        const ADMINISTRATOR      = 1 << 40;  // Bypasses all permission checks
    }
}
```

### Default Roles

**@everyone (default role, assigned on join):**
```
VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | EMBED_LINKS |
READ_MESSAGE_HISTORY | CREATE_INVITE | CONNECT | SPEAK
```

**Admin (created by server owner):**
```
ADMINISTRATOR  (all permissions)
```

---

## 3. Permission Resolution

When checking if a user can perform an action on a channel:

```
1. Is user the server owner?
   → YES: Allow everything. STOP.

2. Compute server-level permissions:
   → Merge all the user's roles (bitwise OR)
   → If ADMINISTRATOR is set: Allow everything. STOP.

3. Apply channel-level overrides:
   → For each of the user's roles, check channel_permission_overrides
   → Start with server-level permissions
   → Apply "allow" bits (OR)
   → Apply "deny" bits (AND NOT)
   → Deny takes precedence over allow

4. Check the required permission bit:
   → If set: Allow
   → If not set: Deny (403)
```

### Rust Implementation

```rust
// domain/services/permission_service.rs

pub fn compute_permissions(
    is_owner: bool,
    role_permissions: &[i64],         // From user's roles
    channel_overrides: &[(i64, i64)], // (allow, deny) per role
) -> Permissions {
    if is_owner {
        return Permissions::all();
    }

    // Merge server-level role permissions
    let mut perms = Permissions::empty();
    for &role_perm in role_permissions {
        perms |= Permissions::from_bits_truncate(role_perm);
    }

    if perms.contains(Permissions::ADMINISTRATOR) {
        return Permissions::all();
    }

    // Apply channel overrides
    let mut allow = Permissions::empty();
    let mut deny = Permissions::empty();
    for &(a, d) in channel_overrides {
        allow |= Permissions::from_bits_truncate(a);
        deny |= Permissions::from_bits_truncate(d);
    }

    perms |= allow;
    perms &= !deny;

    perms
}

pub fn has_permission(perms: Permissions, required: Permissions) -> bool {
    perms.contains(required)
}
```

### Role Hierarchy

Roles have a `position` (integer). Higher position = more authority.

- A user can only modify roles with a position **lower** than their own highest role
- Server owner bypasses position checks
- The `@everyone` role always has `position = 0` (lowest)

---

## 4. Authorization Middleware

```rust
// api/middleware/auth.rs

/// Extracts and validates the JWT from the Authorization header.
/// Sets the authenticated UserId in request extensions.
pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = request.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized("Missing Bearer token"))?;

    let claims = state.jwt_verifier.verify(token)?;
    let user_id = UserId::from(claims.sub);

    request.extensions_mut().insert(user_id);
    Ok(next.run(request).await)
}
```

### Permission Check in Handlers

```rust
// api/handlers/messages.rs

pub async fn send_message(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Path(channel_id): Path<ChannelId>,
    Json(req): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<MessageResponse>), ApiError> {
    // Check permissions
    let perms = state.permission_service
        .get_channel_permissions(user_id, channel_id)
        .await?;

    if !perms.contains(Permissions::SEND_MESSAGES) {
        return Err(ApiError::Forbidden(
            "You do not have SEND_MESSAGES permission in this channel."
        ));
    }

    // ... create message
}
```

---

## 5. Security Considerations

| Threat | Mitigation |
|--------|-----------|
| JWT theft | Short TTL (1h), refresh tokens, Tauri's secure context (no browser extensions) |
| Privilege escalation | Server-side permission checks on every request (never trust client) |
| Role manipulation | Position hierarchy + owner-only bypass |
| Channel snooping | RLS policies as safety net behind API authorization |
| Token in WebSocket URL | Supabase Realtime handles auth via its own JWT validation |
