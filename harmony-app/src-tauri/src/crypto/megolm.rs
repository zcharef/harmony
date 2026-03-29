use std::collections::HashMap;

use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;
use vodozemac::megolm::{
    GroupSession, GroupSessionPickle, InboundGroupSession, InboundGroupSessionPickle,
    MegolmMessage, SessionConfig, SessionKey,
};

use super::CryptoError;
use super::olm::get_or_create_serialization_key;

const MEGOLM_OUTBOUND_SERVICE: &str = "app.joinharmony.megolm.outbound";
const MEGOLM_INBOUND_SERVICE: &str = "app.joinharmony.megolm.inbound";

/// Manages Megolm outbound (sending) and inbound (receiving) group sessions.
///
/// Outbound sessions are keyed by channel_id (one per channel for the local user).
/// Inbound sessions are keyed by "channel_id:session_id" (one per sender session).
pub struct MegolmSessionManager {
    /// Outbound sessions: channel_id -> GroupSession (for sending)
    outbound: HashMap<String, GroupSession>,
    /// Inbound sessions: "channel_id:session_id" -> InboundGroupSession (for receiving)
    inbound: HashMap<String, InboundGroupSession>,
    user_id: Option<String>,
}

impl MegolmSessionManager {
    pub fn new() -> Self {
        Self {
            outbound: HashMap::new(),
            inbound: HashMap::new(),
            user_id: None,
        }
    }

    pub fn set_user_id(&mut self, user_id: String) {
        self.user_id = Some(user_id);
    }

    fn user_id(&self) -> Result<&str, CryptoError> {
        self.user_id
            .as_deref()
            .ok_or(CryptoError::NotInitialized)
    }

    /// Persist all outbound sessions to the OS keychain.
    ///
    /// WHY: vodozemac's `pickle()` is the standard safe serialization for crypto
    /// sessions (not Python pickle). It produces an encrypted JSON blob.
    fn persist_outbound(&self, app: &AppHandle) -> Result<(), CryptoError> {
        let user_id = self.user_id()?;
        let key = get_or_create_serialization_key(app)?;

        let mut session_map: HashMap<String, String> = HashMap::new();
        for (channel_id, session) in &self.outbound {
            let encrypted = session.pickle().encrypt(&key);
            session_map.insert(channel_id.clone(), encrypted);
        }

        let json = serde_json::to_string(&session_map)
            .map_err(|e| CryptoError::StoreError(format!("Outbound serialization failed: {e}")))?;

        app.keyring()
            .set_password(MEGOLM_OUTBOUND_SERVICE, user_id, &json)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?;

        Ok(())
    }

    /// Restore outbound sessions from the OS keychain.
    fn restore_outbound(&mut self, app: &AppHandle) -> Result<(), CryptoError> {
        let user_id = self.user_id()?;
        let key = get_or_create_serialization_key(app)?;

        match app
            .keyring()
            .get_password(MEGOLM_OUTBOUND_SERVICE, user_id)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?
        {
            Some(json) => {
                let session_map: HashMap<String, String> =
                    serde_json::from_str(&json).map_err(|e| {
                        CryptoError::StoreError(format!("Outbound deserialization failed: {e}"))
                    })?;

                for (channel_id, encrypted) in session_map {
                    let restored = GroupSessionPickle::from_encrypted(&encrypted, &key).map_err(
                        |e| {
                            CryptoError::KeychainError(format!(
                                "Outbound session restore failed: {e}"
                            ))
                        },
                    )?;
                    self.outbound
                        .insert(channel_id, GroupSession::from_pickle(restored));
                }
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Persist all inbound sessions to the OS keychain.
    fn persist_inbound(&self, app: &AppHandle) -> Result<(), CryptoError> {
        let user_id = self.user_id()?;
        let key = get_or_create_serialization_key(app)?;

        let mut session_map: HashMap<String, String> = HashMap::new();
        for (composite_key, session) in &self.inbound {
            let encrypted = session.pickle().encrypt(&key);
            session_map.insert(composite_key.clone(), encrypted);
        }

        let json = serde_json::to_string(&session_map)
            .map_err(|e| CryptoError::StoreError(format!("Inbound serialization failed: {e}")))?;

        app.keyring()
            .set_password(MEGOLM_INBOUND_SERVICE, user_id, &json)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?;

        Ok(())
    }

    /// Restore inbound sessions from the OS keychain.
    fn restore_inbound(&mut self, app: &AppHandle) -> Result<(), CryptoError> {
        let user_id = self.user_id()?;
        let key = get_or_create_serialization_key(app)?;

        match app
            .keyring()
            .get_password(MEGOLM_INBOUND_SERVICE, user_id)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?
        {
            Some(json) => {
                let session_map: HashMap<String, String> =
                    serde_json::from_str(&json).map_err(|e| {
                        CryptoError::StoreError(format!("Inbound deserialization failed: {e}"))
                    })?;

                for (composite_key, encrypted) in session_map {
                    let restored =
                        InboundGroupSessionPickle::from_encrypted(&encrypted, &key).map_err(
                            |e| {
                                CryptoError::KeychainError(format!(
                                    "Inbound session restore failed: {e}"
                                ))
                            },
                        )?;
                    self.inbound
                        .insert(composite_key, InboundGroupSession::from_pickle(restored));
                }
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Restore all persisted Megolm sessions.
    pub fn restore_all(&mut self, app: &AppHandle) -> Result<(), CryptoError> {
        self.restore_outbound(app)?;
        self.restore_inbound(app)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

pub type MegolmState = tokio::sync::Mutex<MegolmSessionManager>;

/// Response for outbound session creation and session key export.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct MegolmSessionInfo {
    pub session_id: String,
    pub session_key: String,
}

/// WHY: Manual Debug impl to prevent session_key from leaking into logs/traces.
impl std::fmt::Debug for MegolmSessionInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MegolmSessionInfo")
            .field("session_id", &self.session_id)
            .field("session_key", &"[REDACTED]")
            .finish()
    }
}

/// Response for Megolm encryption.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MegolmEncryptedMessage {
    pub session_id: String,
    pub ciphertext: String,
}

/// Initialize Megolm session manager for a user. Restores persisted sessions.
#[tauri::command]
pub async fn megolm_init(
    app: AppHandle,
    state: tauri::State<'_, MegolmState>,
    user_id: String,
) -> Result<(), CryptoError> {
    let mut mgr = state.lock().await;
    mgr.set_user_id(user_id);
    mgr.restore_all(&app)?;
    Ok(())
}

/// Create a new Megolm outbound session for a channel.
///
/// Returns the session_id and session_key (base64) for sharing with channel members.
/// If an outbound session already exists for this channel, it is replaced.
#[tauri::command]
pub async fn megolm_create_outbound_session(
    app: AppHandle,
    state: tauri::State<'_, MegolmState>,
    channel_id: String,
) -> Result<MegolmSessionInfo, CryptoError> {
    let mut mgr = state.lock().await;

    let session = GroupSession::new(SessionConfig::version_2());
    let session_id = session.session_id();
    let session_key = session.session_key().to_base64();

    mgr.outbound.insert(channel_id, session);
    mgr.persist_outbound(&app)?;

    Ok(MegolmSessionInfo {
        session_id,
        session_key,
    })
}

/// Create an inbound Megolm session from a shared session key.
///
/// The session_key is the base64-encoded key received from the outbound session owner
/// (typically delivered via an Olm-encrypted channel).
/// Returns the session_id for reference.
#[tauri::command]
pub async fn megolm_create_inbound_session(
    app: AppHandle,
    state: tauri::State<'_, MegolmState>,
    channel_id: String,
    session_key: String,
) -> Result<String, CryptoError> {
    let mut mgr = state.lock().await;

    let key = SessionKey::from_base64(&session_key)
        .map_err(|e| CryptoError::InvalidKey(format!("Invalid Megolm session key: {e}")))?;

    let inbound = InboundGroupSession::new(&key, SessionConfig::version_2());
    let session_id = inbound.session_id();

    let composite_key = format!("{}:{}", channel_id, session_id);
    mgr.inbound.insert(composite_key, inbound);
    mgr.persist_inbound(&app)?;

    Ok(session_id)
}

/// Encrypt a plaintext message using the channel's outbound Megolm session.
///
/// Returns the session_id and base64-encoded ciphertext.
/// Errors if no outbound session exists for this channel.
#[tauri::command]
pub async fn megolm_encrypt(
    app: AppHandle,
    state: tauri::State<'_, MegolmState>,
    channel_id: String,
    plaintext: String,
) -> Result<MegolmEncryptedMessage, CryptoError> {
    let mut mgr = state.lock().await;

    let session = mgr.outbound.get_mut(&channel_id).ok_or_else(|| {
        CryptoError::SessionNotFound(format!("No outbound Megolm session for channel {channel_id}"))
    })?;

    let session_id = session.session_id();
    let message = session.encrypt(plaintext.as_bytes());
    let ciphertext = message.to_base64();

    mgr.persist_outbound(&app)?;

    Ok(MegolmEncryptedMessage {
        session_id,
        ciphertext,
    })
}

/// Decrypt a Megolm-encrypted message using the matching inbound session.
///
/// The session_id identifies which inbound session to use.
/// The ciphertext is base64-encoded MegolmMessage.
/// Returns the plaintext string.
#[tauri::command]
pub async fn megolm_decrypt(
    app: AppHandle,
    state: tauri::State<'_, MegolmState>,
    channel_id: String,
    session_id: String,
    ciphertext: String,
) -> Result<String, CryptoError> {
    let mut mgr = state.lock().await;

    let composite_key = format!("{}:{}", channel_id, session_id);
    let session = mgr.inbound.get_mut(&composite_key).ok_or_else(|| {
        CryptoError::SessionNotFound(format!(
            "No inbound Megolm session for channel {channel_id} session {session_id}"
        ))
    })?;

    let message: MegolmMessage = ciphertext
        .as_str()
        .try_into()
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid Megolm ciphertext: {e}")))?;

    let decrypted = session
        .decrypt(&message)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Megolm decryption failed: {e}")))?;

    let plaintext = String::from_utf8(decrypted.plaintext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Plaintext is not valid UTF-8: {e}")))?;

    mgr.persist_inbound(&app)?;

    Ok(plaintext)
}

/// Export the current outbound session key for sharing with new channel members.
///
/// Returns the session_id and session_key (base64).
/// Errors if no outbound session exists for this channel.
///
/// WHY audit log: This command exports sensitive key material with no authorization guard.
/// A proper fix requires a Tauri command permission system (out of scope for now).
/// The tracing::info! creates an audit trail for detecting misuse.
#[tauri::command]
pub async fn megolm_get_session_key(
    state: tauri::State<'_, MegolmState>,
    channel_id: String,
) -> Result<MegolmSessionInfo, CryptoError> {
    tracing::info!(channel_id = %channel_id, "megolm_get_session_key called — session key exported for key distribution");

    let mgr = state.lock().await;

    let session = mgr.outbound.get(&channel_id).ok_or_else(|| {
        CryptoError::SessionNotFound(format!("No outbound Megolm session for channel {channel_id}"))
    })?;

    Ok(MegolmSessionInfo {
        session_id: session.session_id(),
        session_key: session.session_key().to_base64(),
    })
}
