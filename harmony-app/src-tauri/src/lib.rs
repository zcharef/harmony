mod crypto;

use crypto::megolm::{MegolmSessionManager, MegolmState};
use crypto::olm::{CryptoState, OlmAccountManager};
use crypto::store::{MessageCache, MessageCacheState};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_keyring::init())
        .manage(CryptoState::new(OlmAccountManager::new()))
        .manage(MessageCacheState::new(MessageCache::new()))
        .manage(MegolmState::new(MegolmSessionManager::new()))
        .invoke_handler(tauri::generate_handler![
            greet,
            // Olm account management
            crypto::olm::crypto_init,
            crypto::olm::crypto_get_identity_keys,
            crypto::olm::crypto_generate_one_time_keys,
            crypto::olm::crypto_get_one_time_keys,
            crypto::olm::crypto_generate_fallback_key,
            // Olm session management
            crypto::olm::crypto_create_outbound_session,
            crypto::olm::crypto_create_inbound_session,
            crypto::olm::crypto_encrypt,
            crypto::olm::crypto_decrypt,
            crypto::olm::crypto_decrypt_batch,
            // Message cache
            crypto::store::cache_init,
            crypto::store::cache_message,
            crypto::store::get_cached_messages,
            crypto::store::update_cached_message,
            crypto::store::delete_cached_message,
            // Trust & verification
            crypto::olm::crypto_generate_safety_number,
            crypto::store::crypto_set_trust_level,
            crypto::store::crypto_get_trust_level,
            // Megolm group encryption
            crypto::megolm::megolm_init,
            crypto::megolm::megolm_create_outbound_session,
            crypto::megolm::megolm_create_inbound_session,
            crypto::megolm::megolm_encrypt,
            crypto::megolm::megolm_decrypt,
            crypto::megolm::megolm_get_session_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
