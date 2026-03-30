# Harmony — Permissions Matrix

**Last Verified: 2026-03-22**
**Status: Fact-checked by 4 independent audit agents against source code**

---

## Role Hierarchy

| Role | Level | Assignment |
|------|-------|------------|
| Owner | 4 | One per server. Set on creation. Transfer only. |
| Admin | 3 | Assigned by owner or higher-ranked admin |
| Moderator | 2 | Assigned by admin+ |
| Member | 1 | Default on join |

**Enforcement (defense-in-depth):**
- **DB**: `get_role_level(role)` SECURITY DEFINER — `20260322120000_add_roles_to_server_members.sql:74-88`
- **API**: `Role` enum with `level()`, `can_moderate()` — `harmony-api/src/domain/models/role.rs:16-63`
- Hierarchy is strict greater-than: you can only moderate roles **below** yours (`self.level() > target.level()`)

---

## Permissions by Role

### Server & Channel Visibility

| Action | Member | Moderator | Admin | Owner | Enforcement |
|--------|--------|-----------|-------|-------|-------------|
| View server | Yes | Yes | Yes | Yes | RLS: `is_server_member()` — `normalize_rls_helpers.sql:72-75` |
| View public channels | Yes | Yes | Yes | Yes | RLS: `is_channel_member()` — `channel_permissions.sql:97-120` |
| View private channels (implicit) | No | No | Yes | Yes | RLS: `is_channel_member()` checks `get_role_level(role) >= get_role_level('admin')` — `channel_permissions.sql:112` |
| View private channels (explicit grant) | If in `channel_role_access` | If in `channel_role_access` | Yes (implicit) | Yes (implicit) | RLS: `channel_role_access` table — `channel_permissions.sql:33-37` |
| List members | Yes | Yes | Yes | Yes | API: membership check — `handlers/members.rs:35-43` |

### Messaging

| Action | Member | Moderator | Admin | Owner | Enforcement |
|--------|--------|-----------|-------|-------|-------------|
| Send message (public channel) | Yes | Yes | Yes | Yes | RLS + API: `message_service.rs:81-126`, `rls_role_based_policies.sql:77-90` |
| Send message (read-only channel) | No | No | Yes | Yes | RLS + API: `message_service.rs:94-106`, `rls_role_based_policies.sql:84` |
| Edit own message | Yes | Yes | Yes | Yes | RLS: `messages_update_author` policy, API: `message_service.rs:172-176` |
| Delete own message | Yes | Yes | Yes | Yes | API: `message_service.rs:200` (author check) |
| Delete others' messages | No | Yes | Yes | Yes | API: `message_service.rs:200-224` (moderator+ role check) |
| Add/remove own reactions | Yes | Yes | Yes | Yes | RLS: `message_reactions_insert_own`, `message_reactions_delete_own` — `normalize_rls_helpers.sql:182-200` |

### Moderation

| Action | Member | Moderator | Admin | Owner | Enforcement |
|--------|--------|-----------|-------|-------|-------------|
| Kick (lower roles only) | No | Yes | Yes | Yes | API: `moderation_service.rs:202-237` — requires `Role::Moderator` + hierarchy |
| Ban/unban | No | No | Yes | Yes | API: `moderation_service.rs:132-188` — requires `Role::Admin` + hierarchy |
| List bans | No | No | Yes | Yes | API: `moderation_service.rs:249` — requires `Role::Admin` |
| Change roles (lower roles only) | No | No | Yes | Yes | API: `moderation_service.rs:260-307` — requires `Role::Admin` + hierarchy |
| Assign owner role | No | No | No | No | Blocked: `role.rs:49-51` — `is_assignable()` returns false for Owner |
| Transfer ownership | No | No | No | Yes | API: `moderation_service.rs:318-353` — `require_owner()` |

### Channel Management

| Action | Member | Moderator | Admin | Owner | Enforcement |
|--------|--------|-----------|-------|-------|-------------|
| Create channel | No | No | Yes | Yes | API: `handlers/channels.rs:79-82`, RLS: `channels_insert_admin` — `rls_role_based_policies.sql:49-53` |
| Edit channel | No | No | Yes | Yes | API: `handlers/channels.rs:128-131`, RLS: `channels_update_admin` — `rls_role_based_policies.sql:56-60` |
| Delete channel | No | No | Yes | Yes | API: `handlers/channels.rs:168-171`, RLS: `channels_delete_admin` — `rls_role_based_policies.sql:63-66` |
| Set private/read-only | No | No | Yes | Yes | API: `handlers/channels.rs` create/update handlers wire `is_private`/`is_read_only` through DTO → service → repo |

### Server Management

| Action | Member | Moderator | Admin | Owner | Enforcement |
|--------|--------|-----------|-------|-------|-------------|
| Edit server (name/desc) | No | No | Yes | Yes | RLS: `servers_update_admin` — `rls_role_based_policies.sql:24-26` |
| Delete server | No | No | No | Yes | RLS: `servers_delete_owner` — `rls_hardening.sql:100-102` |
| Leave server | Yes | Yes | Yes | Yes | RLS: `server_members_delete_own` — `rls_hardening.sql:186-194` |
| Create invites | Yes | Yes | Yes | Yes | RLS: `invites_insert_member` — `rls_role_based_policies.sql:158-165` |

### Direct Messages

| Action | Any authenticated user | Enforcement |
|--------|----------------------|-------------|
| Create DM | Yes (10/hour limit) | API: `dm_service.rs:129-136` |
| List DMs | Yes (own only) | API: `dm_service.rs:161-173` |
| Close DM | Yes (hard-leave) | API: `dm_service.rs:181-209` |
| Ban/kick in DM | No | API: `moderation_service.rs:136-140`, `moderation_service.rs:206-209` |
| Create invite for DM | No | API: `invite_service.rs:66-69`, RLS: `rls_role_based_policies.sql:164` |

---

## Defense-in-Depth Architecture

Every permission is enforced at **two independent layers**:

1. **API service layer** (Rust) — primary enforcer for HTTP clients
2. **RLS policies** (PostgreSQL) — safety net for Realtime/PowerSync clients

Neither layer trusts the other. The API uses `service_role` (bypasses RLS) but enforces its own role checks. RLS protects against direct database access.

Additionally:
- `protect_message_content` trigger prevents moderators from modifying anything except `deleted_at`/`deleted_by` on messages — `add_deleted_by_to_messages.sql:29-55`
- `server_members_update_own` WITH CHECK prevents role self-promotion — `security_hardening.sql:65-72`
- DM creation uses `FOR SHARE` locks to prevent race conditions — `dm_repository.rs:84-88`
- Ownership transfer uses `SELECT FOR UPDATE` for atomicity — `member_repository.rs`

---

## Known Limitations (Deferred to Backlog)

- No API endpoint to manage `channel_role_access` (PATCH /access) — private channels are admin+-only until this ships
- No `?role=` query filter on members endpoint — frontend groups client-side
- Per-endpoint DM rate limiting not implemented — domain-level 10/hour exists
- Role access checkboxes UI for private channels — depends on PATCH /access endpoint
