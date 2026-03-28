pub mod megolm;
pub mod olm;
pub mod store;

#[cfg(test)]
mod tests;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("Account not initialized")]
    NotInitialized,
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("Keychain error: {0}")]
    KeychainError(String),
    #[error("Store error: {0}")]
    StoreError(String),
    #[error("Invalid key format: {0}")]
    InvalidKey(String),
    #[error("SQLCipher error: {0}")]
    CacheError(String),
}

// Tauri requires command errors to be serializable as strings
impl Serialize for CryptoError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct OneTimeKeyInfo {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct FallbackKeyInfo {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct IdentityKeysResponse {
    pub identity_key: String,
    pub signing_key: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct InitResponse {
    pub identity_key: String,
    pub signing_key: String,
    pub one_time_keys: Vec<OneTimeKeyInfo>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct InboundSessionResult {
    pub session_id: String,
    pub plaintext: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct EncryptedMessage {
    pub message_type: usize,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DecryptRequest {
    pub session_id: String,
    pub message_type: usize,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DecryptResult {
    pub session_id: String,
    pub plaintext: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct CachedMessage {
    pub message_id: String,
    pub channel_id: String,
    pub plaintext: String,
    pub created_at: String,
}
