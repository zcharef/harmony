use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_keyring::KeyringExt;
use vodozemac::olm::{
    Account, AccountPickle, InboundCreationResult, OlmMessage, Session, SessionConfig,
    SessionPickle,
};
use vodozemac::Curve25519PublicKey;

use super::{
    CryptoError, DecryptRequest, DecryptResult, EncryptedMessage, FallbackKeyInfo,
    IdentityKeysResponse, InboundSessionResult, InitResponse, OneTimeKeyInfo,
};

const KEYRING_SERVICE: &str = "app.joinharmony.crypto";
const SESSIONS_SERVICE: &str = "app.joinharmony.sessions";
const PICKLE_KEY_SERVICE: &str = "app.joinharmony.pickle-key";

/// Retrieve the 32-byte pickle serialization key from the OS keychain,
/// or generate and store a new random one on first use.
///
/// WHY: A hardcoded key makes vodozemac pickle encryption meaningless.
/// The OS keychain provides the actual access-control boundary.
pub(super) fn get_or_create_serialization_key(app: &AppHandle) -> Result<[u8; 32], CryptoError> {
    match app
        .keyring()
        .get_password(PICKLE_KEY_SERVICE, "default")
        .map_err(|e| CryptoError::KeychainError(e.to_string()))?
    {
        Some(hex_str) => {
            let bytes = hex::decode(&hex_str).map_err(|e| {
                CryptoError::KeychainError(format!("Pickle key hex decode failed: {e}"))
            })?;
            let key: [u8; 32] = bytes.try_into().map_err(|_| {
                CryptoError::KeychainError("Pickle key is not 32 bytes".to_string())
            })?;
            Ok(key)
        }
        None => {
            let mut key = [0u8; 32];
            // WHY: getrandom reads directly from OS entropy — smallest attack surface for key material.
            getrandom::fill(&mut key)
                .map_err(|e| CryptoError::KeychainError(format!("OS RNG failed: {e}")))?;
            let hex_str = hex::encode(key);

            app.keyring()
                .set_password(PICKLE_KEY_SERVICE, "default", &hex_str)
                .map_err(|e| CryptoError::KeychainError(e.to_string()))?;

            Ok(key)
        }
    }
}

/// WHY: `account` and `user_id` are co-dependent — both must be Some or both None.
/// Invariant enforced by `require_initialized()` pattern at every command entry point
/// (both fields checked via `.ok_or(CryptoError::NotInitialized)?`).
/// TODO: Refactor to `enum AccountState { Uninitialized, Ready { account: Account, user_id: String } }`
pub struct OlmAccountManager {
    account: Option<Account>,
    sessions: HashMap<String, Session>,
    user_id: Option<String>,
}

impl OlmAccountManager {
    pub fn new() -> Self {
        Self {
            account: None,
            sessions: HashMap::new(),
            user_id: None,
        }
    }

    /// Persist the current account state to the OS keychain.
    fn persist_account(&self, app: &AppHandle) -> Result<(), CryptoError> {
        let account = self.account.as_ref().ok_or(CryptoError::NotInitialized)?;
        let user_id = self.user_id.as_ref().ok_or(CryptoError::NotInitialized)?;
        let key = get_or_create_serialization_key(app)?;

        let serialized = account.pickle();
        let encrypted = serialized.encrypt(&key);

        app.keyring()
            .set_password(KEYRING_SERVICE, user_id, &encrypted)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?;

        Ok(())
    }

    /// Try to restore an account from the OS keychain.
    fn restore_account(&mut self, app: &AppHandle, user_id: &str) -> Result<bool, CryptoError> {
        match app
            .keyring()
            .get_password(KEYRING_SERVICE, user_id)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?
        {
            Some(encrypted) => {
                let key = get_or_create_serialization_key(app)?;
                let restored = AccountPickle::from_encrypted(&encrypted, &key).map_err(|e| {
                    CryptoError::KeychainError(format!("Account restore failed: {e}"))
                })?;
                self.account = Some(Account::from(restored));
                self.user_id = Some(user_id.to_string());
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Persist all sessions to keychain as JSON of encrypted serialized sessions.
    fn persist_sessions(&self, app: &AppHandle) -> Result<(), CryptoError> {
        let user_id = self.user_id.as_ref().ok_or(CryptoError::NotInitialized)?;
        let key = get_or_create_serialization_key(app)?;

        let mut session_map: HashMap<String, String> = HashMap::new();
        for (session_id, session) in &self.sessions {
            let serialized = session.pickle();
            let encrypted = serialized.encrypt(&key);
            session_map.insert(session_id.clone(), encrypted);
        }

        let json = serde_json::to_string(&session_map)
            .map_err(|e| CryptoError::StoreError(format!("Session serialization failed: {e}")))?;

        app.keyring()
            .set_password(SESSIONS_SERVICE, user_id, &json)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?;

        Ok(())
    }

    /// Restore sessions from keychain.
    fn restore_sessions(&mut self, app: &AppHandle) -> Result<(), CryptoError> {
        let user_id = self.user_id.as_ref().ok_or(CryptoError::NotInitialized)?;

        match app
            .keyring()
            .get_password(SESSIONS_SERVICE, user_id)
            .map_err(|e| CryptoError::KeychainError(e.to_string()))?
        {
            Some(json) => {
                let key = get_or_create_serialization_key(app)?;
                let session_map: HashMap<String, String> =
                    serde_json::from_str(&json).map_err(|e| {
                        CryptoError::StoreError(format!("Session deserialization failed: {e}"))
                    })?;

                for (session_id, encrypted) in session_map {
                    let restored =
                        SessionPickle::from_encrypted(&encrypted, &key).map_err(|e| {
                            CryptoError::KeychainError(format!("Session restore failed: {e}"))
                        })?;
                    self.sessions
                        .insert(session_id, Session::from(restored));
                }
                Ok(())
            }
            None => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

pub type CryptoState = tokio::sync::Mutex<OlmAccountManager>;

/// Initialize crypto account: create or restore from keychain.
/// Returns identity keys and initial one-time keys for server upload.
#[tauri::command]
pub async fn crypto_init(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    user_id: String,
) -> Result<InitResponse, CryptoError> {
    let mut mgr = state.lock().await;

    // Try to restore existing account
    let restored = mgr.restore_account(&app, &user_id)?;

    if !restored {
        let mut account = Account::new();
        account.generate_one_time_keys(50);
        account.generate_fallback_key();

        // WHY: Collect keys BEFORE marking published — mark_keys_as_published()
        // clears the unpublished set, so one_time_keys() would return empty after.
        let one_time_keys: Vec<OneTimeKeyInfo> = account
            .one_time_keys()
            .into_iter()
            .map(|(key_id, public_key)| OneTimeKeyInfo {
                key_id: key_id.to_base64(),
                public_key: public_key.to_base64(),
            })
            .collect();

        let identity_key = account.curve25519_key().to_base64();
        let signing_key = account.ed25519_key().to_base64();

        account.mark_keys_as_published();

        mgr.account = Some(account);
        mgr.user_id = Some(user_id.clone());
        mgr.persist_account(&app)?;
        mgr.restore_sessions(&app)?;

        return Ok(InitResponse {
            identity_key,
            signing_key,
            one_time_keys,
        });
    }

    // Restored account — sessions are already persisted, just reload them
    mgr.restore_sessions(&app)?;

    let account = mgr.account.as_ref().ok_or(CryptoError::NotInitialized)?;

    Ok(InitResponse {
        identity_key: account.curve25519_key().to_base64(),
        signing_key: account.ed25519_key().to_base64(),
        // WHY: Restored accounts have no unpublished keys (they were marked
        // published before persisting). This is correct — the server already
        // has the keys from the original crypto_init call.
        one_time_keys: Vec::new(),
    })
}

/// Return the account's public identity keys.
#[tauri::command]
pub async fn crypto_get_identity_keys(
    state: tauri::State<'_, CryptoState>,
) -> Result<IdentityKeysResponse, CryptoError> {
    let mgr = state.lock().await;
    let account = mgr.account.as_ref().ok_or(CryptoError::NotInitialized)?;

    Ok(IdentityKeysResponse {
        identity_key: account.curve25519_key().to_base64(),
        signing_key: account.ed25519_key().to_base64(),
    })
}

/// Generate new one-time keys and mark them published.
#[tauri::command]
pub async fn crypto_generate_one_time_keys(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    count: usize,
) -> Result<Vec<OneTimeKeyInfo>, CryptoError> {
    let mut mgr = state.lock().await;
    let account = mgr.account.as_mut().ok_or(CryptoError::NotInitialized)?;

    account.generate_one_time_keys(count);

    // Collect unpublished keys before marking
    let keys: Vec<OneTimeKeyInfo> = account
        .one_time_keys()
        .into_iter()
        .map(|(key_id, public_key)| OneTimeKeyInfo {
            key_id: key_id.to_base64(),
            public_key: public_key.to_base64(),
        })
        .collect();

    account.mark_keys_as_published();
    mgr.persist_account(&app)?;

    Ok(keys)
}

/// Return currently unpublished one-time keys.
#[tauri::command]
pub async fn crypto_get_one_time_keys(
    state: tauri::State<'_, CryptoState>,
) -> Result<Vec<OneTimeKeyInfo>, CryptoError> {
    let mgr = state.lock().await;
    let account = mgr.account.as_ref().ok_or(CryptoError::NotInitialized)?;

    let keys: Vec<OneTimeKeyInfo> = account
        .one_time_keys()
        .into_iter()
        .map(|(key_id, public_key)| OneTimeKeyInfo {
            key_id: key_id.to_base64(),
            public_key: public_key.to_base64(),
        })
        .collect();

    Ok(keys)
}

/// Generate or rotate the fallback key (MSC2732).
#[tauri::command]
pub async fn crypto_generate_fallback_key(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
) -> Result<FallbackKeyInfo, CryptoError> {
    let mut mgr = state.lock().await;
    let account = mgr.account.as_mut().ok_or(CryptoError::NotInitialized)?;

    account.generate_fallback_key();

    let fallback = account.fallback_key();
    let (key_id, public_key) = fallback
        .into_iter()
        .next()
        .ok_or_else(|| CryptoError::InvalidKey("No fallback key generated".to_string()))?;

    account.mark_keys_as_published();
    mgr.persist_account(&app)?;

    Ok(FallbackKeyInfo {
        key_id: key_id.to_base64(),
        public_key: public_key.to_base64(),
    })
}

/// Create an outbound Olm session from the recipient's identity and one-time key.
/// Returns the session_id for subsequent encrypt/decrypt calls.
#[tauri::command]
pub async fn crypto_create_outbound_session(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    their_identity_key: String,
    their_one_time_key: String,
) -> Result<String, CryptoError> {
    let mut mgr = state.lock().await;
    let account = mgr.account.as_ref().ok_or(CryptoError::NotInitialized)?;

    let identity_key = Curve25519PublicKey::from_base64(&their_identity_key)
        .map_err(|e| CryptoError::InvalidKey(format!("Invalid identity key: {e}")))?;

    let one_time_key = Curve25519PublicKey::from_base64(&their_one_time_key)
        .map_err(|e| CryptoError::InvalidKey(format!("Invalid one-time key: {e}")))?;

    let session =
        account.create_outbound_session(SessionConfig::version_2(), identity_key, one_time_key);

    let session_id = session.session_id();
    mgr.sessions.insert(session_id.clone(), session);
    mgr.persist_sessions(&app)?;

    Ok(session_id)
}

/// Create an inbound Olm session from a received pre-key message.
/// Decrypts the first message and returns both session_id and plaintext.
#[tauri::command]
pub async fn crypto_create_inbound_session(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    identity_key: String,
    message: String,
) -> Result<InboundSessionResult, CryptoError> {
    let mut mgr = state.lock().await;
    let account = mgr.account.as_mut().ok_or(CryptoError::NotInitialized)?;

    let their_identity_key = Curve25519PublicKey::from_base64(&identity_key)
        .map_err(|e| CryptoError::InvalidKey(format!("Invalid identity key: {e}")))?;

    // Decode the base64 message body into raw bytes
    let message_bytes = BASE64
        .decode(&message)
        .map_err(|e| CryptoError::InvalidKey(format!("Invalid base64 message: {e}")))?;

    // Parse as a pre-key message (message_type = 0)
    let olm_message = OlmMessage::from_parts(0, &message_bytes)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid OlmMessage: {e}")))?;

    let pre_key_message = match olm_message {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => {
            return Err(CryptoError::DecryptionFailed(
                "Expected pre-key message for inbound session creation".to_string(),
            ));
        }
    };

    let InboundCreationResult { session, plaintext } = account
        .create_inbound_session(their_identity_key, &pre_key_message)
        .map_err(|e| {
            CryptoError::DecryptionFailed(format!("Inbound session creation failed: {e}"))
        })?;

    let session_id = session.session_id();
    let plaintext_str = String::from_utf8(plaintext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Plaintext is not valid UTF-8: {e}")))?;

    mgr.sessions.insert(session_id.clone(), session);
    mgr.persist_account(&app)?;
    mgr.persist_sessions(&app)?;

    Ok(InboundSessionResult {
        session_id,
        plaintext: plaintext_str,
    })
}

/// Encrypt a plaintext message using the specified session.
/// Returns message_type and base64-encoded ciphertext.
#[tauri::command]
pub async fn crypto_encrypt(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    session_id: String,
    plaintext: String,
) -> Result<EncryptedMessage, CryptoError> {
    let mut mgr = state.lock().await;

    let session = mgr
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| CryptoError::SessionNotFound(session_id.clone()))?;

    let olm_message = session.encrypt(plaintext.as_bytes());
    let (message_type, ciphertext_bytes) = olm_message.to_parts();
    let ciphertext = BASE64.encode(&ciphertext_bytes);

    mgr.persist_sessions(&app)?;

    Ok(EncryptedMessage {
        message_type,
        ciphertext,
    })
}

/// Decrypt a single message using the specified session.
#[tauri::command]
pub async fn crypto_decrypt(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    session_id: String,
    message_type: usize,
    ciphertext: String,
) -> Result<String, CryptoError> {
    let mut mgr = state.lock().await;

    let session = mgr
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| CryptoError::SessionNotFound(session_id.clone()))?;

    let ciphertext_bytes = BASE64
        .decode(&ciphertext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid base64 ciphertext: {e}")))?;

    let olm_message = OlmMessage::from_parts(message_type, &ciphertext_bytes)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Invalid OlmMessage: {e}")))?;

    let plaintext_bytes = session
        .decrypt(&olm_message)
        .map_err(|e| CryptoError::DecryptionFailed(format!("{e}")))?;

    let plaintext = String::from_utf8(plaintext_bytes)
        .map_err(|e| CryptoError::DecryptionFailed(format!("Plaintext is not valid UTF-8: {e}")))?;

    mgr.persist_sessions(&app)?;

    Ok(plaintext)
}

/// Batch-decrypt multiple messages. Returns results for each, with per-item error handling.
#[tauri::command]
pub async fn crypto_decrypt_batch(
    app: AppHandle,
    state: tauri::State<'_, CryptoState>,
    messages: Vec<DecryptRequest>,
) -> Result<Vec<DecryptResult>, CryptoError> {
    let mut mgr = state.lock().await;
    let mut results = Vec::with_capacity(messages.len());

    for (i, req) in messages.iter().enumerate() {
        let result = match mgr.sessions.get_mut(&req.session_id) {
            None => {
                let err = format!("Session not found: {}", req.session_id);
                tracing::warn!(index = i, error = %err, "batch_decrypt_item_failed");
                DecryptResult {
                    session_id: req.session_id.clone(),
                    plaintext: None,
                    error: Some(err),
                }
            }
            Some(session) => match BASE64.decode(&req.ciphertext) {
                Err(e) => {
                    let err = format!("Invalid base64: {e}");
                    tracing::warn!(index = i, error = %err, "batch_decrypt_item_failed");
                    DecryptResult {
                        session_id: req.session_id.clone(),
                        plaintext: None,
                        error: Some(err),
                    }
                }
                Ok(ciphertext_bytes) => {
                    match OlmMessage::from_parts(req.message_type, &ciphertext_bytes) {
                        Err(e) => {
                            let err = format!("Invalid OlmMessage: {e}");
                            tracing::warn!(index = i, error = %err, "batch_decrypt_item_failed");
                            DecryptResult {
                                session_id: req.session_id.clone(),
                                plaintext: None,
                                error: Some(err),
                            }
                        }
                        Ok(olm_message) => match session.decrypt(&olm_message) {
                            Err(e) => {
                                let err = format!("Decryption failed: {e}");
                                tracing::warn!(index = i, error = %err, "batch_decrypt_item_failed");
                                DecryptResult {
                                    session_id: req.session_id.clone(),
                                    plaintext: None,
                                    error: Some(err),
                                }
                            }
                            Ok(plaintext_bytes) => match String::from_utf8(plaintext_bytes) {
                                Err(e) => {
                                    let err = format!("Invalid UTF-8: {e}");
                                    tracing::warn!(index = i, error = %err, "batch_decrypt_item_failed");
                                    DecryptResult {
                                        session_id: req.session_id.clone(),
                                        plaintext: None,
                                        error: Some(err),
                                    }
                                }
                                Ok(plaintext) => DecryptResult {
                                    session_id: req.session_id.clone(),
                                    plaintext: Some(plaintext),
                                    error: None,
                                },
                            },
                        },
                    }
                }
            },
        };
        results.push(result);
    }

    mgr.persist_sessions(&app)?;

    Ok(results)
}

/// Generate a deterministic safety number from two identity keys.
/// WHY: Both users compute the same number because keys are sorted before hashing.
/// This allows out-of-band verification (compare numbers in person or via phone).
#[tauri::command]
pub async fn crypto_generate_safety_number(
    our_identity_key: String,
    their_identity_key: String,
) -> Result<String, CryptoError> {
    Ok(generate_safety_number(
        &our_identity_key,
        &their_identity_key,
    ))
}

/// Pure function for safety number generation (also used by tests).
pub fn generate_safety_number(our_key: &str, their_key: &str) -> String {
    // WHY: Sort keys lexicographically so both users produce the same hash.
    let (first, second) = if our_key <= their_key {
        (our_key, their_key)
    } else {
        (their_key, our_key)
    };

    let mut hasher = Sha256::new();
    hasher.update(first.as_bytes());
    hasher.update(second.as_bytes());
    let hash = hasher.finalize();

    // WHY: Take the first 30 bytes, convert each pair to a 5-digit number.
    // 15 pairs × 5 digits = 75 digits total, grouped by spaces.
    let mut groups: Vec<String> = Vec::with_capacity(15);
    for i in 0..15 {
        let byte1 = hash[i * 2] as u32;
        let byte2 = hash[i * 2 + 1] as u32;
        let number = ((byte1 << 8) | byte2) % 100_000;
        groups.push(format!("{number:05}"));
    }

    groups.join(" ")
}
