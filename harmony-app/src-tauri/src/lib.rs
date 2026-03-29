mod crypto;

use crypto::megolm::{MegolmSessionManager, MegolmState};
use crypto::olm::{CryptoState, OlmAccountManager};
use crypto::store::{MessageCache, MessageCacheState};
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WHY: DSN from env avoids hardcoding credentials in source.
    // In production builds, SENTRY_DSN must be set as an env var during CI compilation (see release.yml).
    // If unset, Sentry is silently disabled (empty string = no-op).
    let dsn = option_env!("SENTRY_DSN").unwrap_or("");
    let client = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: sentry::release_name!(),
            environment: Some(
                option_env!("SENTRY_ENVIRONMENT").unwrap_or("development").into(),
            ),
            auto_session_tracking: true,
            ..Default::default()
        },
    ));

    // WHY: Minidump captures native crashes (segfaults, stack overflows) in a separate
    // crash reporter process so they reach Sentry even if the main process is dead.
    #[cfg(not(target_os = "ios"))]
    let _guard = tauri_plugin_sentry::minidump::init(&client);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // WHY: On Windows/Linux, deep links spawn a new process.
            // The single-instance plugin with "deep-link" feature forwards
            // the URL to the existing process via onOpenUrl instead.
            // Focus the existing window so the user sees the app respond.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_sentry::init(&client))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── greet command ────────────────────────────────────────

    #[test]
    fn greet_includes_name_in_response() {
        let result = greet("Alice");
        assert!(
            result.contains("Alice"),
            "Greeting should contain the provided name, got: {result}"
        );
    }

    #[test]
    fn greet_with_empty_name() {
        let result = greet("");
        assert!(
            result.contains("Hello, !"),
            "Greeting with empty name should still produce output, got: {result}"
        );
    }

    #[test]
    fn greet_with_special_characters() {
        let result = greet("O'Brien <script>");
        assert!(
            result.contains("O'Brien <script>"),
            "Greeting should preserve special characters verbatim, got: {result}"
        );
    }

    // ── CryptoError serialization ────────────────────────────

    #[test]
    fn crypto_error_serializes_as_string() {
        let error = crypto::CryptoError::NotInitialized;
        let json = serde_json::to_string(&error)
            .expect("CryptoError should be JSON-serializable");

        // WHY: Tauri commands return errors as serialized strings.
        // The Display impl produces "Account not initialized".
        assert!(
            json.contains("Account not initialized"),
            "Serialized error should contain the Display message, got: {json}"
        );
    }

    #[test]
    fn crypto_error_variants_serialize_with_context() {
        let variants: Vec<(crypto::CryptoError, &str)> = vec![
            (
                crypto::CryptoError::SessionNotFound("sess-123".to_string()),
                "sess-123",
            ),
            (
                crypto::CryptoError::DecryptionFailed("bad MAC".to_string()),
                "bad MAC",
            ),
            (
                crypto::CryptoError::KeychainError("access denied".to_string()),
                "access denied",
            ),
            (
                crypto::CryptoError::StoreError("disk full".to_string()),
                "disk full",
            ),
            (
                crypto::CryptoError::InvalidKey("wrong length".to_string()),
                "wrong length",
            ),
            (
                crypto::CryptoError::CacheError("not initialized".to_string()),
                "not initialized",
            ),
        ];

        for (error, expected_fragment) in variants {
            let json = serde_json::to_string(&error)
                .expect("CryptoError variant should serialize");
            assert!(
                json.contains(expected_fragment),
                "Serialized '{error}' should contain '{expected_fragment}', got: {json}"
            );
        }
    }

    // ── Safety number (pure function, no runtime) ────────────

    #[test]
    fn safety_number_is_commutative() {
        let key_a = "TestKeyAlpha000000000000000000000000000==";
        let key_b = "TestKeyBravo000000000000000000000000000==";

        let ab = crypto::olm::generate_safety_number(key_a, key_b);
        let ba = crypto::olm::generate_safety_number(key_b, key_a);

        assert_eq!(
            ab, ba,
            "Safety number must be the same regardless of argument order"
        );
    }

    #[test]
    fn safety_number_changes_with_different_keys() {
        let key_a = "TestKeyAlpha000000000000000000000000000==";
        let key_b = "TestKeyBravo000000000000000000000000000==";
        let key_c = "TestKeyCharl000000000000000000000000000==";

        let ab = crypto::olm::generate_safety_number(key_a, key_b);
        let ac = crypto::olm::generate_safety_number(key_a, key_c);

        assert_ne!(
            ab, ac,
            "Different key pairs must produce different safety numbers"
        );
    }

    // ── State types are constructible ────────────────────────

    #[test]
    fn crypto_state_type_is_constructible() {
        // WHY: Verify the Mutex<OlmAccountManager> type alias works as expected.
        let state = CryptoState::new(OlmAccountManager::new());
        // Confirm we can lock it (not deadlocked)
        let guard = state.try_lock();
        assert!(
            guard.is_ok(),
            "CryptoState should be lockable immediately after construction"
        );
    }

    #[test]
    fn message_cache_state_type_is_constructible() {
        let state = MessageCacheState::new(MessageCache::new());
        let guard = state.try_lock();
        assert!(
            guard.is_ok(),
            "MessageCacheState should be lockable immediately after construction"
        );
    }

    #[test]
    fn megolm_state_type_is_constructible() {
        let state = MegolmState::new(MegolmSessionManager::new());
        let guard = state.try_lock();
        assert!(
            guard.is_ok(),
            "MegolmState should be lockable immediately after construction"
        );
    }
}
