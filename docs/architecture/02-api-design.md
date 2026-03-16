# Harmony — API Design

> **Framework:** Axum 0.8
> **Format:** REST (real-time via Supabase Realtime)
> **Docs:** Code-first OpenAPI 3.1 via utoipa
> **Errors:** RFC 9457 ProblemDetails
> **Versioning:** URL-based (`/v1/`)

---

## 1. API Conventions

### Base URL
- **Development:** `http://localhost:3000/v1`
- **Production:** `https://api.harmony.app/v1`

### Authentication
- Bearer token (Supabase JWT) in `Authorization` header
- The Rust API verifies the JWT signature using the Supabase JWT secret (HS256)

### Response Format

**Single resource:**
```json
{
  "id": "550e8400-...",
  "name": "general",
  "created_at": "2026-02-15T10:00:00Z"
}
```

**Collection (always enveloped):**
```json
{
  "items": [...],
  "total": 142,
  "cursor": "2026-02-15T09:59:00Z"
}
```

**Error (RFC 9457):**
```json
{
  "type": "https://api.harmony.app/problems/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "You do not have SEND_MESSAGES permission in this channel.",
  "instance": "/v1/channels/abc123/messages"
}
```

### Status Codes

| Operation | Success | Error |
|-----------|---------|-------|
| GET resource | 200 | 404 |
| GET collection | 200 | — |
| POST create | 201 | 400, 409 |
| PATCH update | 200 | 400, 404 |
| DELETE | 204 | 404 |
| Auth failure | — | 401 |
| Permission denied | — | 403 |
| Rate limited | — | 429 |

### Pagination

Cursor-based (not offset-based) for messages. Use `created_at` as cursor.

```
GET /v1/channels/{id}/messages?before=2026-02-15T10:00:00Z&limit=50
```

---

## 2. Endpoint Reference

### 2.1 Auth (Supabase-Managed)

Auth is handled client-side via the Supabase JS SDK. The Rust API only **verifies** JWTs.

| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `POST /v1/auth/me` | Get or create profile | Called after Supabase login; creates profile if first login |

### 2.2 Profiles

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/v1/profiles/{id}` | Get user profile | Yes |
| `GET` | `/v1/profiles/me` | Get own profile | Yes |
| `PATCH` | `/v1/profiles/me` | Update own profile | Yes |
| `GET` | `/v1/profiles?search={query}` | Search profiles by username | Yes |

**PATCH /v1/profiles/me** body:
```json
{
  "display_name": "Zayd",
  "avatar_url": "...",
  "custom_status": "Building Harmony"
}
```

### 2.3 Servers

| Method | Path | Description | Auth | Permission |
|--------|------|-------------|------|------------|
| `POST` | `/v1/servers` | Create a server | Yes | — |
| `GET` | `/v1/servers` | List user's servers | Yes | — |
| `GET` | `/v1/servers/{id}` | Get server details | Yes | Member |
| `PATCH` | `/v1/servers/{id}` | Update server | Yes | MANAGE_SERVER |
| `DELETE` | `/v1/servers/{id}` | Delete server | Yes | Owner only |

**POST /v1/servers** body:
```json
{
  "name": "Rust Devs",
  "description": "A server for Rustaceans"
}
```

**Response (201):**
```json
{
  "id": "...",
  "name": "Rust Devs",
  "description": "A server for Rustaceans",
  "icon_url": null,
  "owner_id": "...",
  "member_count": 1,
  "created_at": "..."
}
```

**Side effects:**
- Creates `@everyone` default role with basic permissions
- Creates "General" category with `#general` text channel
- Adds creator as server member with owner role

### 2.4 Server Members

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/v1/servers/{id}/members` | List members | Member |
| `POST` | `/v1/servers/{id}/members` | Join server (via invite code) | — |
| `DELETE` | `/v1/servers/{id}/members/{userId}` | Kick member | KICK_MEMBERS |
| `DELETE` | `/v1/servers/{id}/members/me` | Leave server | Member |
| `PATCH` | `/v1/servers/{id}/members/{userId}` | Update nickname/roles | MANAGE_MEMBERS |

**POST (join via invite):**
```json
{
  "invite_code": "abc123"
}
```

### 2.5 Channels

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/v1/servers/{id}/channels` | List channels + categories | Member |
| `POST` | `/v1/servers/{id}/channels` | Create channel | MANAGE_CHANNELS |
| `PATCH` | `/v1/channels/{id}` | Update channel | MANAGE_CHANNELS |
| `DELETE` | `/v1/channels/{id}` | Delete channel | MANAGE_CHANNELS |

**POST body:**
```json
{
  "name": "rust-help",
  "channel_type": "text",
  "category_id": "...",
  "topic": "Ask Rust questions here"
}
```

### 2.6 Messages

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/v1/channels/{id}/messages` | List messages (cursor-paginated) | VIEW_CHANNEL |
| `POST` | `/v1/channels/{id}/messages` | Send message | SEND_MESSAGES |
| `PATCH` | `/v1/messages/{id}` | Edit message | Author only |
| `DELETE` | `/v1/messages/{id}` | Delete message | Author or MANAGE_MESSAGES |

**POST body:**
```json
{
  "content": "Hello **world**!",
  "reply_to_id": null
}
```

**Query params for GET:**
- `before` (ISO 8601 timestamp) — cursor for backward pagination
- `after` (ISO 8601 timestamp) — cursor for forward pagination (new messages)
- `limit` (1-100, default 50)

### 2.7 Roles

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/v1/servers/{id}/roles` | List roles | Member |
| `POST` | `/v1/servers/{id}/roles` | Create role | MANAGE_ROLES |
| `PATCH` | `/v1/roles/{id}` | Update role (name, permissions, color) | MANAGE_ROLES |
| `DELETE` | `/v1/roles/{id}` | Delete role | MANAGE_ROLES |
| `PUT` | `/v1/servers/{id}/members/{userId}/roles/{roleId}` | Assign role | MANAGE_ROLES |
| `DELETE` | `/v1/servers/{id}/members/{userId}/roles/{roleId}` | Remove role | MANAGE_ROLES |

**Role hierarchy:** A user can only manage roles with a `position` lower than their highest role. The owner bypasses this.

### 2.8 Invites

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `GET` | `/v1/servers/{id}/invites` | List active invites | MANAGE_SERVER |
| `POST` | `/v1/servers/{id}/invites` | Create invite | CREATE_INVITE |
| `DELETE` | `/v1/invites/{code}` | Revoke invite | MANAGE_SERVER |
| `GET` | `/v1/invites/{code}` | Preview invite (server name, member count) | No auth |

### 2.9 File Upload

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| `POST` | `/v1/channels/{id}/attachments` | Upload file | SEND_MESSAGES + ATTACH_FILES |

**Flow:**
1. Client uploads file via `multipart/form-data` to the Rust API
2. API validates file type/size, stores in Supabase Storage
3. API returns attachment metadata (id, URL, dimensions)
4. Client includes attachment IDs when sending the message

### 2.10 Real-Time Events

Real-time push notifications are handled entirely by **Supabase Realtime**, not the Rust API. There is no SSE or WebSocket endpoint in the API.

See [03-realtime.md](./03-realtime.md) for Supabase Realtime channels, Postgres Changes, Broadcast, and Presence.

---

## 3. Rust Implementation Pattern

Every endpoint follows the same pattern:

```
Handler (api/) → Service (domain/) → Port trait (domain/) → Adapter (infra/)
```

### Example: Create Server

```rust
// api/handlers/servers.rs
#[utoipa::path(
    post, path = "/v1/servers",
    request_body = CreateServerRequest,
    responses(
        (status = 201, body = ServerResponse),
        (status = 400, body = ProblemDetails),
    ),
    security(("bearer" = []))
)]
pub async fn create_server(
    State(state): State<AppState>,
    AuthUser(user_id): AuthUser,
    Json(req): Json<CreateServerRequest>,
) -> Result<(StatusCode, Json<ServerResponse>), ApiError> {
    let server = state.server_service
        .create_server(user_id, req.try_into()?)
        .await?;

    Ok((StatusCode::CREATED, Json(server.into())))
}
```

```rust
// domain/services/server_service.rs
pub async fn create_server(
    &self,
    owner_id: UserId,
    input: CreateServerInput,
) -> Result<Server, DomainError> {
    let server = Server::new(input.name, input.description, owner_id);
    let default_role = Role::default_everyone(server.id);
    let general_channel = Channel::default_general(server.id);

    self.server_repo.create_with_defaults(server, default_role, general_channel).await
}
```

---

## 4. Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Global (per IP) | 60 requests | 5 minutes |
| Message send (per user) | 10 messages | 10 seconds |
| Server create (per user) | 5 servers | 1 hour |
| File upload (per user) | 20 files | 1 hour |

Rate limit headers included in responses:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1708000000
```
