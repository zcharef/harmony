use std::path::PathBuf;

use rusqlite::Connection;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_keyring::KeyringExt;

use super::{CachedMessage, CryptoError};

/// WHY: Validates that a user_id is a well-formed UUID before using it in filesystem paths.
/// Prevents path traversal attacks (e.g. user_id = "../../etc/passwd").
fn validate_user_id(user_id: &str) -> Result<uuid::Uuid, CryptoError> {
    user_id
        .parse::<uuid::Uuid>()
        .map_err(|_| CryptoError::CacheError("user_id must be a valid UUID".to_string()))
}

const KEYRING_SERVICE: &str = "app.joinharmony.sqlcipher";

pub struct MessageCache {
    conn: Option<Connection>,
}

impl MessageCache {
    pub fn new() -> Self {
        Self { conn: None }
    }

    /// Open (or create) the SQLCipher-encrypted message cache for the given user.
    pub fn open(&mut self, app: &AppHandle, user_id: &str) -> Result<(), CryptoError> {
        let validated_id = validate_user_id(user_id)?;

        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| CryptoError::CacheError(format!("Failed to resolve app data dir: {e}")))?;

        let user_dir = app_data_dir.join(validated_id.to_string());
        std::fs::create_dir_all(&user_dir)
            .map_err(|e| CryptoError::CacheError(format!("Failed to create user dir: {e}")))?;

        let db_path = user_dir.join("messages.sqlite");
        let hex_key = self.get_or_create_db_key(app, user_id)?;

        let conn = self.open_db(&db_path, &hex_key)?;
        self.conn = Some(conn);

        Ok(())
    }

    /// Get the existing SQLCipher key from keychain, or generate a new one.
    fn get_or_create_db_key(
        &self,
        app: &AppHandle,
        user_id: &str,
    ) -> Result<String, CryptoError> {
        // Try to retrieve existing key
        match app
            .keyring()
            .get_password(KEYRING_SERVICE, user_id)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?
        {
            Some(key) => Ok(key),
            None => {
                // Generate a new 256-bit random key
                let mut key_bytes = [0u8; 32];
                // WHY: getrandom reads directly from OS entropy with no in-process
                // state — smallest attack surface for cryptographic key material.
                getrandom::fill(&mut key_bytes)
                    .map_err(|e| CryptoError::CacheError(format!("OS RNG failed: {e}")))?;
                let hex_key = hex::encode(key_bytes);

                app.keyring()
                    .set_password(KEYRING_SERVICE, user_id, &hex_key)
                    .map_err(|e| CryptoError::KeychainError(e.to_string()))?;

                Ok(hex_key)
            }
        }
    }

    /// Open the SQLCipher database, run PRAGMA key, verify integrity, create schema.
    fn open_db(&self, db_path: &PathBuf, hex_key: &str) -> Result<Connection, CryptoError> {
        let conn = Connection::open(db_path)
            .map_err(|e| CryptoError::CacheError(format!("Failed to open SQLCipher db: {e}")))?;

        // Set the raw hex key (no PBKDF2)
        conn.execute_batch(&format!("PRAGMA key = \"x'{hex_key}'\";"))
            .map_err(|e| CryptoError::CacheError(format!("PRAGMA key failed: {e}")))?;

        // WHY: Distinguish actual corruption (recoverable by recreating) from query errors
        // (possibly wrong key / locked DB) which must not silently delete the cache.
        match conn.query_row("PRAGMA integrity_check;", [], |row| row.get::<_, String>(0)) {
            Ok(result) if result == "ok" => { /* DB is valid, proceed to schema */ }
            Ok(result) => {
                tracing::warn!(result = %result, "SQLCipher integrity check failed — recreating database");

                // Drop connection, delete file, reopen
                drop(conn);
                std::fs::remove_file(db_path).map_err(|e| {
                    CryptoError::CacheError(format!("Failed to remove corrupt db: {e}"))
                })?;

                let conn = Connection::open(db_path).map_err(|e| {
                    CryptoError::CacheError(format!("Failed to reopen db: {e}"))
                })?;

                conn.execute_batch(&format!("PRAGMA key = \"x'{hex_key}'\";"))
                    .map_err(|e| {
                        CryptoError::CacheError(format!("PRAGMA key failed on new db: {e}"))
                    })?;

                self.create_schema(&conn)?;
                return Ok(conn);
            }
            Err(e) => {
                return Err(CryptoError::CacheError(
                    format!("Integrity check query failed (possible wrong key): {e}")
                ));
            }
        }

        self.create_schema(&conn)?;
        Ok(conn)
    }

    fn create_schema(&self, conn: &Connection) -> Result<(), CryptoError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS cached_messages (
                message_id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                plaintext TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_cached_messages_channel
                ON cached_messages(channel_id, created_at);

            CREATE TABLE IF NOT EXISTS known_identity_keys (
                user_id TEXT PRIMARY KEY,
                identity_key TEXT NOT NULL,
                first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS trust_levels (
                user_id TEXT PRIMARY KEY,
                trust_level TEXT NOT NULL DEFAULT 'unverified',
                verified_at TEXT
            );",
        )
        .map_err(|e| CryptoError::CacheError(format!("Schema creation failed: {e}")))?;

        Ok(())
    }

    fn conn(&self) -> Result<&Connection, CryptoError> {
        self.conn.as_ref().ok_or(CryptoError::CacheError(
            "Message cache not initialized — call cache_init first".to_string(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

pub type MessageCacheState = tokio::sync::Mutex<MessageCache>;

/// Initialize the message cache for a user. Must be called before other cache commands.
#[tauri::command]
pub async fn cache_init(
    app: AppHandle,
    state: tauri::State<'_, MessageCacheState>,
    user_id: String,
) -> Result<(), CryptoError> {
    let mut cache = state.lock().await;
    cache.open(&app, &user_id)?;
    Ok(())
}

/// Upsert a decrypted message into the local cache.
#[tauri::command]
pub async fn cache_message(
    state: tauri::State<'_, MessageCacheState>,
    message_id: String,
    channel_id: String,
    plaintext: String,
    created_at: String,
) -> Result<(), CryptoError> {
    let cache = state.lock().await;
    let conn = cache.conn()?;

    conn.execute(
        "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(message_id) DO UPDATE SET
            plaintext = excluded.plaintext,
            created_at = excluded.created_at",
        rusqlite::params![message_id, channel_id, plaintext, created_at],
    )
    .map_err(|e| CryptoError::CacheError(format!("Insert failed: {e}")))?;

    Ok(())
}

/// Retrieve cached messages for a channel, with cursor-based pagination.
#[tauri::command]
pub async fn get_cached_messages(
    state: tauri::State<'_, MessageCacheState>,
    channel_id: String,
    before_cursor: Option<String>,
    limit: u32,
) -> Result<Vec<CachedMessage>, CryptoError> {
    let cache = state.lock().await;
    let conn = cache.conn()?;

    let mut messages = Vec::new();

    match before_cursor {
        Some(cursor) => {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id, channel_id, plaintext, created_at
                     FROM cached_messages
                     WHERE channel_id = ?1 AND created_at < ?2
                     ORDER BY created_at DESC
                     LIMIT ?3",
                )
                .map_err(|e| CryptoError::CacheError(format!("Query prepare failed: {e}")))?;

            let rows = stmt
                .query_map(rusqlite::params![channel_id, cursor, limit], |row| {
                    Ok(CachedMessage {
                        message_id: row.get(0)?,
                        channel_id: row.get(1)?,
                        plaintext: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                })
                .map_err(|e| CryptoError::CacheError(format!("Query failed: {e}")))?;

            for row in rows {
                messages.push(
                    row.map_err(|e| CryptoError::CacheError(format!("Row read failed: {e}")))?,
                );
            }
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT message_id, channel_id, plaintext, created_at
                     FROM cached_messages
                     WHERE channel_id = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| CryptoError::CacheError(format!("Query prepare failed: {e}")))?;

            let rows = stmt
                .query_map(rusqlite::params![channel_id, limit], |row| {
                    Ok(CachedMessage {
                        message_id: row.get(0)?,
                        channel_id: row.get(1)?,
                        plaintext: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                })
                .map_err(|e| CryptoError::CacheError(format!("Query failed: {e}")))?;

            for row in rows {
                messages.push(
                    row.map_err(|e| CryptoError::CacheError(format!("Row read failed: {e}")))?,
                );
            }
        }
    }

    Ok(messages)
}

/// Update the plaintext of a cached message (for edits).
#[tauri::command]
pub async fn update_cached_message(
    state: tauri::State<'_, MessageCacheState>,
    message_id: String,
    new_plaintext: String,
) -> Result<(), CryptoError> {
    let cache = state.lock().await;
    let conn = cache.conn()?;

    let rows_affected = conn
        .execute(
            "UPDATE cached_messages SET plaintext = ?1 WHERE message_id = ?2",
            rusqlite::params![new_plaintext, message_id],
        )
        .map_err(|e| CryptoError::CacheError(format!("Update failed: {e}")))?;

    if rows_affected == 0 {
        return Err(CryptoError::CacheError(format!(
            "Message not found: {message_id}"
        )));
    }

    Ok(())
}

/// Delete a cached message.
#[tauri::command]
pub async fn delete_cached_message(
    state: tauri::State<'_, MessageCacheState>,
    message_id: String,
) -> Result<(), CryptoError> {
    let cache = state.lock().await;
    let conn = cache.conn()?;

    conn.execute(
        "DELETE FROM cached_messages WHERE message_id = ?1",
        rusqlite::params![message_id],
    )
    .map_err(|e| CryptoError::CacheError(format!("Delete failed: {e}")))?;

    Ok(())
}

/// Set the trust level for a user. Only stored locally — the server never knows.
#[tauri::command]
pub async fn crypto_set_trust_level(
    state: tauri::State<'_, MessageCacheState>,
    user_id: String,
    level: String,
) -> Result<(), CryptoError> {
    // WHY: Validate the level string to prevent garbage data in SQLite.
    if level != "unverified" && level != "verified" && level != "blocked" {
        return Err(CryptoError::CacheError(format!(
            "Invalid trust level: {level}. Must be 'unverified', 'verified', or 'blocked'"
        )));
    }

    let cache = state.lock().await;
    let conn = cache.conn()?;

    let verified_at = if level == "verified" {
        Some(chrono_now())
    } else {
        None
    };

    conn.execute(
        "INSERT INTO trust_levels (user_id, trust_level, verified_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET
            trust_level = excluded.trust_level,
            verified_at = excluded.verified_at",
        rusqlite::params![user_id, level, verified_at],
    )
    .map_err(|e| CryptoError::CacheError(format!("Set trust level failed: {e}")))?;

    Ok(())
}

/// Get the trust level for a user. Returns "unverified" if no record exists.
#[tauri::command]
pub async fn crypto_get_trust_level(
    state: tauri::State<'_, MessageCacheState>,
    user_id: String,
) -> Result<String, CryptoError> {
    let cache = state.lock().await;
    let conn = cache.conn()?;

    let result = conn.query_row(
        "SELECT trust_level FROM trust_levels WHERE user_id = ?1",
        rusqlite::params![user_id],
        |row| row.get::<_, String>(0),
    );

    match result {
        Ok(level) => Ok(level),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok("unverified".to_string()),
        Err(e) => Err(CryptoError::CacheError(format!(
            "Get trust level failed: {e}"
        ))),
    }
}

/// Returns current time as Unix epoch seconds string.
/// WHY: Simple timestamp without pulling in chrono crate. Used for ordering/auditing only.
fn chrono_now() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();

    // WHY: epoch 0 means the system clock is before 1970 — timestamps will be wrong.
    if secs == 0 {
        tracing::warn!(epoch_secs = secs, "System clock returned epoch 0 — timestamps will be incorrect");
    }

    format!("{secs}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_user_id ─────────────────────────────────────

    #[test]
    fn validate_user_id_accepts_valid_uuid() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let result = validate_user_id(id);
        assert!(result.is_ok(), "Valid UUID v4 should be accepted");
        assert_eq!(
            result.unwrap().to_string(),
            id,
            "Parsed UUID should roundtrip to the same string"
        );
    }

    #[test]
    fn validate_user_id_rejects_empty_string() {
        let result = validate_user_id("");
        assert!(result.is_err(), "Empty string is not a valid UUID");
    }

    #[test]
    fn validate_user_id_rejects_path_traversal() {
        let result = validate_user_id("../../etc/passwd");
        assert!(result.is_err(), "Path traversal string must be rejected");
    }

    #[test]
    fn validate_user_id_rejects_plain_text() {
        let result = validate_user_id("not-a-uuid-at-all");
        assert!(result.is_err(), "Arbitrary text must be rejected");
    }

    #[test]
    fn validate_user_id_rejects_partial_uuid() {
        let result = validate_user_id("550e8400-e29b-41d4");
        assert!(result.is_err(), "Truncated UUID must be rejected");
    }

    // ── chrono_now ───────────────────────────────────────────

    #[test]
    fn chrono_now_returns_numeric_string() {
        let now = chrono_now();
        assert!(
            now.chars().all(|c| c.is_ascii_digit()),
            "chrono_now should return only digits, got '{now}'"
        );
    }

    #[test]
    fn chrono_now_returns_reasonable_epoch() {
        let now = chrono_now();
        let secs: u64 = now.parse().expect("chrono_now should be parseable as u64");

        // WHY: 1_700_000_000 ≈ 2023-11-14. Any system running these tests
        // should have a clock past that date.
        assert!(
            secs > 1_700_000_000,
            "Timestamp {secs} is suspiciously low — system clock may be wrong"
        );
    }

    // ── MessageCache construction ────────────────────────────

    #[test]
    fn message_cache_new_is_uninitialized() {
        let cache = MessageCache::new();
        assert!(
            cache.conn.is_none(),
            "Freshly constructed cache should have no connection"
        );
    }

    #[test]
    fn message_cache_conn_errors_when_uninitialized() {
        let cache = MessageCache::new();
        let result = cache.conn();
        assert!(
            result.is_err(),
            "conn() on uninitialized cache must return Err"
        );
        let err_msg = result.unwrap_err().to_string();
        assert!(
            err_msg.contains("not initialized"),
            "Error should mention 'not initialized', got: {err_msg}"
        );
    }

    // ── Schema creation (in-memory SQLite) ───────────────────

    /// WHY: Opens an in-memory SQLite connection and runs create_schema to verify
    /// the DDL is syntactically correct and idempotent. No keychain/Tauri needed.
    fn open_test_cache() -> MessageCache {
        let conn = Connection::open_in_memory().expect("in-memory SQLite should open");
        let mut cache = MessageCache::new();
        cache
            .create_schema(&conn)
            .expect("Schema creation should succeed");
        cache.conn = Some(conn);
        cache
    }

    #[test]
    fn create_schema_succeeds_on_fresh_db() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite should open");
        let cache = MessageCache::new();
        let result = cache.create_schema(&conn);
        assert!(result.is_ok(), "Schema creation on a fresh DB should succeed");
    }

    #[test]
    fn create_schema_is_idempotent() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite should open");
        let cache = MessageCache::new();
        cache.create_schema(&conn).unwrap();
        // Run again — IF NOT EXISTS should make this a no-op
        let result = cache.create_schema(&conn);
        assert!(
            result.is_ok(),
            "Running create_schema twice should succeed (IF NOT EXISTS)"
        );
    }

    #[test]
    fn schema_creates_expected_tables() {
        let conn = Connection::open_in_memory().expect("in-memory SQLite should open");
        let cache = MessageCache::new();
        cache.create_schema(&conn).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(
            tables.contains(&"cached_messages".to_string()),
            "cached_messages table should exist, found: {tables:?}"
        );
        assert!(
            tables.contains(&"known_identity_keys".to_string()),
            "known_identity_keys table should exist, found: {tables:?}"
        );
        assert!(
            tables.contains(&"trust_levels".to_string()),
            "trust_levels table should exist, found: {tables:?}"
        );
    }

    // ── Message CRUD (in-memory, no Tauri runtime) ───────────

    #[test]
    fn insert_and_query_cached_message() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        conn.execute(
            "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["msg-1", "chan-1", "hello world", "1700000001"],
        )
        .expect("Insert should succeed");

        let plaintext: String = conn
            .query_row(
                "SELECT plaintext FROM cached_messages WHERE message_id = ?1",
                rusqlite::params!["msg-1"],
                |row| row.get(0),
            )
            .expect("Query should return the inserted row");

        assert_eq!(plaintext, "hello world", "Plaintext should match inserted value");
    }

    #[test]
    fn upsert_updates_existing_message() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        // Insert original
        conn.execute(
            "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["msg-1", "chan-1", "original", "1700000001"],
        )
        .unwrap();

        // Upsert with new plaintext (same SQL as cache_message command)
        conn.execute(
            "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(message_id) DO UPDATE SET
                plaintext = excluded.plaintext,
                created_at = excluded.created_at",
            rusqlite::params!["msg-1", "chan-1", "updated", "1700000002"],
        )
        .unwrap();

        let plaintext: String = conn
            .query_row(
                "SELECT plaintext FROM cached_messages WHERE message_id = ?1",
                rusqlite::params!["msg-1"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(plaintext, "updated", "Upsert should overwrite plaintext");
    }

    #[test]
    fn query_messages_by_channel_ordered_desc() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        let rows = [
            ("m1", "chan-a", "first", "1700000001"),
            ("m2", "chan-a", "second", "1700000002"),
            ("m3", "chan-b", "other channel", "1700000003"),
            ("m4", "chan-a", "third", "1700000004"),
        ];

        for (id, ch, pt, ts) in &rows {
            conn.execute(
                "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, ch, pt, ts],
            )
            .unwrap();
        }

        // Same query as get_cached_messages (no cursor)
        let mut stmt = conn
            .prepare(
                "SELECT message_id, channel_id, plaintext, created_at
                 FROM cached_messages
                 WHERE channel_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2",
            )
            .unwrap();

        let messages: Vec<CachedMessage> = stmt
            .query_map(rusqlite::params!["chan-a", 10], |row| {
                Ok(CachedMessage {
                    message_id: row.get(0)?,
                    channel_id: row.get(1)?,
                    plaintext: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(messages.len(), 3, "Should return 3 messages for chan-a");
        assert_eq!(
            messages[0].plaintext, "third",
            "Most recent message should come first (DESC order)"
        );
        assert_eq!(messages[2].plaintext, "first", "Oldest message should come last");
    }

    #[test]
    fn cursor_pagination_returns_older_messages() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        for i in 1..=5 {
            conn.execute(
                "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    format!("m{i}"),
                    "chan-a",
                    format!("msg {i}"),
                    format!("170000000{i}")
                ],
            )
            .unwrap();
        }

        // Cursor-based: get messages before timestamp of m3
        let mut stmt = conn
            .prepare(
                "SELECT message_id, channel_id, plaintext, created_at
                 FROM cached_messages
                 WHERE channel_id = ?1 AND created_at < ?2
                 ORDER BY created_at DESC
                 LIMIT ?3",
            )
            .unwrap();

        let messages: Vec<CachedMessage> = stmt
            .query_map(
                rusqlite::params!["chan-a", "1700000003", 10],
                |row| {
                    Ok(CachedMessage {
                        message_id: row.get(0)?,
                        channel_id: row.get(1)?,
                        plaintext: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                },
            )
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(messages.len(), 2, "Should return 2 messages before the cursor");
        assert_eq!(messages[0].message_id, "m2", "Should return m2 first (DESC)");
        assert_eq!(messages[1].message_id, "m1", "Should return m1 second");
    }

    #[test]
    fn update_nonexistent_message_returns_zero_rows() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        let rows_affected = conn
            .execute(
                "UPDATE cached_messages SET plaintext = ?1 WHERE message_id = ?2",
                rusqlite::params!["new text", "nonexistent-id"],
            )
            .unwrap();

        assert_eq!(
            rows_affected, 0,
            "Updating a nonexistent message should affect 0 rows"
        );
    }

    #[test]
    fn delete_cached_message_removes_row() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        conn.execute(
            "INSERT INTO cached_messages (message_id, channel_id, plaintext, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["msg-del", "chan-1", "to delete", "1700000001"],
        )
        .unwrap();

        conn.execute(
            "DELETE FROM cached_messages WHERE message_id = ?1",
            rusqlite::params!["msg-del"],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cached_messages WHERE message_id = ?1",
                rusqlite::params!["msg-del"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(count, 0, "Deleted message should no longer exist");
    }

    // ── Trust levels (in-memory, no Tauri runtime) ───────────

    #[test]
    fn trust_level_defaults_to_unverified() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        let result = conn.query_row(
            "SELECT trust_level FROM trust_levels WHERE user_id = ?1",
            rusqlite::params!["unknown-user"],
            |row| row.get::<_, String>(0),
        );

        // WHY: The command layer returns "unverified" on QueryReturnedNoRows.
        // At the SQL level, no row means Err.
        assert!(
            matches!(result, Err(rusqlite::Error::QueryReturnedNoRows)),
            "Querying unknown user should return no rows"
        );
    }

    #[test]
    fn trust_level_insert_and_update() {
        let cache = open_test_cache();
        let conn = cache.conn().unwrap();

        let user_id = "550e8400-e29b-41d4-a716-446655440000";

        // Insert as verified
        conn.execute(
            "INSERT INTO trust_levels (user_id, trust_level, verified_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET
                trust_level = excluded.trust_level,
                verified_at = excluded.verified_at",
            rusqlite::params![user_id, "verified", Some("1700000001")],
        )
        .unwrap();

        let level: String = conn
            .query_row(
                "SELECT trust_level FROM trust_levels WHERE user_id = ?1",
                rusqlite::params![user_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(level, "verified", "Trust level should be 'verified'");

        // Update to blocked
        conn.execute(
            "INSERT INTO trust_levels (user_id, trust_level, verified_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET
                trust_level = excluded.trust_level,
                verified_at = excluded.verified_at",
            rusqlite::params![user_id, "blocked", Option::<String>::None],
        )
        .unwrap();

        let level: String = conn
            .query_row(
                "SELECT trust_level FROM trust_levels WHERE user_id = ?1",
                rusqlite::params![user_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(level, "blocked", "Trust level should be updated to 'blocked'");
    }

    // ── open_db (plaintext, no SQLCipher key needed) ─────────

    #[test]
    fn open_db_creates_schema_on_new_file() {
        let dir = tempfile::tempdir().expect("tempdir should be created");
        let db_path = dir.path().join("test.sqlite");
        let cache = MessageCache::new();

        // WHY: Using empty hex_key because bundled-sqlcipher with an empty PRAGMA key
        // effectively opens an unencrypted DB, which is fine for testing schema creation.
        let conn = cache.open_db(&db_path, "").expect("open_db should succeed");

        // Verify schema was created
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('cached_messages', 'known_identity_keys', 'trust_levels')",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(table_count, 3, "All 3 tables should be created by open_db");
    }

    // ── Key generation (pure crypto, no keychain) ────────────

    #[test]
    fn generated_db_key_is_64_hex_chars() {
        let mut key_bytes = [0u8; 32];
        getrandom::fill(&mut key_bytes).expect("getrandom should succeed");
        let hex_key = hex::encode(key_bytes);

        assert_eq!(
            hex_key.len(),
            64,
            "hex-encoded 32-byte key should be 64 chars"
        );
        assert!(
            hex_key.chars().all(|c| c.is_ascii_hexdigit()),
            "All characters should be valid hex digits"
        );
    }

    #[test]
    fn generated_db_keys_are_unique() {
        let mut key1 = [0u8; 32];
        let mut key2 = [0u8; 32];
        getrandom::fill(&mut key1).expect("getrandom fill key1");
        getrandom::fill(&mut key2).expect("getrandom fill key2");

        assert_ne!(
            hex::encode(key1),
            hex::encode(key2),
            "Two consecutive random keys should differ"
        );
    }

    #[test]
    fn db_key_hex_roundtrip_preserves_bytes() {
        let mut key_bytes = [0u8; 32];
        getrandom::fill(&mut key_bytes).expect("getrandom fill");

        let hex_key = hex::encode(key_bytes);
        let decoded = hex::decode(&hex_key).expect("hex decode should succeed");
        let roundtrip: [u8; 32] = decoded
            .try_into()
            .expect("decoded key should be exactly 32 bytes");

        assert_eq!(
            roundtrip, key_bytes,
            "Hex roundtrip should preserve the original key bytes"
        );
    }

    #[test]
    fn generated_db_key_is_not_all_zeros() {
        let mut key_bytes = [0u8; 32];
        getrandom::fill(&mut key_bytes).expect("getrandom should succeed");

        assert_ne!(
            key_bytes,
            [0u8; 32],
            "Random key should not be all zeros (probability ~2^-256)"
        );
    }
}
