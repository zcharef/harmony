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
    let client = sentry::init((
        "https://a451fbc1d5091713d710f6db748a29af@o4509859895181312.ingest.de.sentry.io/4511112066695248",
        sentry::ClientOptions {
            release: sentry::release_name!(),
            auto_session_tracking: true,
            ..Default::default()
        },
    ));

    // WHY: Minidump captures native crashes (segfaults, stack overflows) in a separate
    // crash reporter process so they reach Sentry even if the main process is dead.
    #[cfg(not(target_os = "ios"))]
    let _guard = tauri_plugin_sentry::minidump::init(&client);

    tauri::Builder::default()
        .plugin(tauri_plugin_sentry::init(&client))
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
