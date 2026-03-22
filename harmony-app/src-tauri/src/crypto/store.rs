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

const KEYRING_SERVICE: &str = "com.harmony.sqlcipher";

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
