use base64::engine::general_purpose::STANDARD_NO_PAD as BASE64;
use base64::Engine;
use serde_json;
use vodozemac::megolm::{
    GroupSession, InboundGroupSession, MegolmMessage,
    SessionConfig as MegolmSessionConfig, SessionKey,
};
use vodozemac::olm::{Account, InboundCreationResult, OlmMessage, SessionConfig};

use super::olm::generate_safety_number;

#[test]
fn test_generate_account() {
    let account = Account::new();
    let identity_key = account.curve25519_key().to_base64();
    let signing_key = account.ed25519_key().to_base64();

    // Keys should be non-empty valid base64
    assert!(
        !identity_key.is_empty(),
        "Identity key should not be empty"
    );
    assert!(
        !signing_key.is_empty(),
        "Signing key should not be empty"
    );

    // base64 decode should succeed
    assert!(
        BASE64.decode(&identity_key).is_ok(),
        "Identity key should be valid base64"
    );
    assert!(
        BASE64.decode(&signing_key).is_ok(),
        "Signing key should be valid base64"
    );

    // Curve25519 key should decode to 32 bytes
    let identity_bytes = BASE64.decode(&identity_key).unwrap();
    assert_eq!(
        identity_bytes.len(),
        32,
        "Curve25519 key should be 32 bytes"
    );
}

#[test]
fn test_encrypt_decrypt_roundtrip() {
    // Alice creates an account and publishes one-time keys
    let mut alice = Account::new();
    alice.generate_one_time_keys(5);

    let alice_identity_key = alice.curve25519_key();
    let alice_one_time_key = *alice
        .one_time_keys()
        .values()
        .next()
        .expect("Alice should have one-time keys");

    alice.mark_keys_as_published();

    // Bob creates an account
    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();

    // Bob creates an outbound session to Alice using her identity + one-time key
    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_one_time_key,
    );

    // Bob encrypts a message to Alice
    let original_message = "Hello Alice, this is a secret message!";
    let encrypted = bob_session.encrypt(original_message.as_bytes());

    // The first message should be a PreKey message
    let (message_type, ciphertext_bytes) = encrypted.to_parts();
    assert_eq!(message_type, 0, "First message should be PreKey type (0)");

    // Alice receives the PreKey message and creates an inbound session
    let olm_message = OlmMessage::from_parts(message_type, &ciphertext_bytes)
        .expect("Should parse OlmMessage from parts");

    let pre_key_message = match olm_message {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey message"),
    };

    let InboundCreationResult {
        session: mut alice_session,
        plaintext,
    } = alice
        .create_inbound_session(bob_identity_key, &pre_key_message)
        .expect("Alice should create inbound session");

    let decrypted = String::from_utf8(plaintext).expect("Plaintext should be valid UTF-8");
    assert_eq!(
        decrypted, original_message,
        "Decrypted text should match original"
    );

    // Alice replies to Bob
    let reply = "Hi Bob, I got your message!";
    let reply_encrypted = alice_session.encrypt(reply.as_bytes());

    let decrypted_reply_bytes = bob_session
        .decrypt(&reply_encrypted)
        .expect("Bob should decrypt Alice's reply");
    let decrypted_reply =
        String::from_utf8(decrypted_reply_bytes).expect("Reply should be valid UTF-8");
    assert_eq!(
        decrypted_reply, reply,
        "Bob should receive Alice's original reply"
    );
}

#[test]
fn test_multiple_messages() {
    // Set up Alice and Bob with established sessions
    let mut alice = Account::new();
    alice.generate_one_time_keys(5);
    let alice_identity_key = alice.curve25519_key();
    let alice_one_time_key = *alice.one_time_keys().values().next().unwrap();
    alice.mark_keys_as_published();

    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();

    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_one_time_key,
    );

    // Bob sends the first (pre-key) message to establish session
    let first_msg = "Establishing session";
    let encrypted_first = bob_session.encrypt(first_msg.as_bytes());
    let (msg_type, ct_bytes) = encrypted_first.to_parts();
    let olm_msg = OlmMessage::from_parts(msg_type, &ct_bytes).unwrap();
    let pre_key = match olm_msg {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey"),
    };
    let InboundCreationResult {
        session: mut alice_session,
        plaintext: first_plaintext,
    } = alice
        .create_inbound_session(bob_identity_key, &pre_key)
        .unwrap();
    assert_eq!(
        String::from_utf8(first_plaintext).unwrap(),
        first_msg
    );

    // Now send 5 more messages from Bob to Alice (normal messages)
    let messages = [
        "Message 1: Hello!",
        "Message 2: How are you?",
        "Message 3: The weather is nice.",
        "Message 4: Let's meet tomorrow.",
        "Message 5: Goodbye!",
    ];

    for original in &messages {
        let encrypted = bob_session.encrypt(original.as_bytes());
        let decrypted_bytes = alice_session
            .decrypt(&encrypted)
            .expect("Alice should decrypt each message");
        let decrypted =
            String::from_utf8(decrypted_bytes).expect("Each message should be valid UTF-8");
        assert_eq!(
            &decrypted, original,
            "Each decrypted message should match the original"
        );
    }

    // Verify bidirectional: Alice sends 5 messages to Bob
    let alice_messages = [
        "Reply 1: Hi!",
        "Reply 2: Fine, thanks!",
        "Reply 3: Indeed!",
        "Reply 4: Sure!",
        "Reply 5: Bye!",
    ];

    for original in &alice_messages {
        let encrypted = alice_session.encrypt(original.as_bytes());
        let decrypted_bytes = bob_session
            .decrypt(&encrypted)
            .expect("Bob should decrypt Alice's messages");
        let decrypted =
            String::from_utf8(decrypted_bytes).expect("Each reply should be valid UTF-8");
        assert_eq!(
            &decrypted, original,
            "Each decrypted reply should match the original"
        );
    }
}

#[test]
fn test_fallback_key_generation() {
    let mut account = Account::new();

    // Initially no fallback key
    let initial_fallback = account.fallback_key();
    assert!(
        initial_fallback.is_empty(),
        "Should have no fallback key initially"
    );

    // Generate a fallback key
    account.generate_fallback_key();
    let fallback = account.fallback_key();
    assert_eq!(
        fallback.len(),
        1,
        "Should have exactly one fallback key"
    );

    let (key_id, public_key) = fallback.into_iter().next().unwrap();
    let key_id_b64 = key_id.to_base64();
    let public_key_b64 = public_key.to_base64();

    assert!(!key_id_b64.is_empty(), "Fallback key ID should not be empty");
    assert!(
        !public_key_b64.is_empty(),
        "Fallback public key should not be empty"
    );

    // Verify the public key is valid base64 and 32 bytes
    let decoded = BASE64
        .decode(&public_key_b64)
        .expect("Fallback key should be valid base64");
    assert_eq!(decoded.len(), 32, "Fallback key should be 32 bytes");

    // Rotating: generate another fallback key
    account.generate_fallback_key();
    let new_fallback = account.fallback_key();
    assert_eq!(
        new_fallback.len(),
        1,
        "Should still have exactly one fallback key after rotation"
    );

    let (_, new_public_key) = new_fallback.into_iter().next().unwrap();
    let new_key_b64 = new_public_key.to_base64();

    // New key should differ from old key (extremely high probability with random generation)
    assert_ne!(
        public_key_b64, new_key_b64,
        "Rotated fallback key should differ from previous"
    );
}

#[test]
fn test_one_time_key_generation() {
    let mut account = Account::new();

    // Generate 10 one-time keys
    account.generate_one_time_keys(10);
    let keys = account.one_time_keys();
    assert_eq!(keys.len(), 10, "Should have 10 one-time keys");

    // All keys should be valid base64 and unique
    let mut seen_keys = std::collections::HashSet::new();
    for public_key in keys.values() {
        let b64 = public_key.to_base64();
        assert!(!b64.is_empty(), "One-time key should not be empty");
        let decoded = BASE64.decode(&b64).expect("Key should be valid base64");
        assert_eq!(decoded.len(), 32, "Each key should be 32 bytes");
        assert!(
            seen_keys.insert(b64),
            "All one-time keys should be unique"
        );
    }

    // After marking as published, one_time_keys() should return empty
    account.mark_keys_as_published();
    let published_keys = account.one_time_keys();
    assert!(
        published_keys.is_empty(),
        "No unpublished keys should remain after mark_keys_as_published"
    );
}

#[test]
fn test_base64_wire_format_roundtrip() {
    // Verify that base64 encoding/decoding of ciphertext preserves the message
    let mut alice = Account::new();
    alice.generate_one_time_keys(1);
    let alice_identity_key = alice.curve25519_key();
    let alice_otk = *alice.one_time_keys().values().next().unwrap();
    alice.mark_keys_as_published();

    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();

    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk,
    );

    let plaintext = "Testing base64 wire format";
    let encrypted = bob_session.encrypt(plaintext.as_bytes());
    let (msg_type, raw_bytes) = encrypted.to_parts();

    // Simulate wire format: base64 encode
    let wire_b64 = BASE64.encode(&raw_bytes);

    // Simulate receiving: base64 decode
    let received_bytes = BASE64.decode(&wire_b64).expect("Wire base64 should decode");
    assert_eq!(
        raw_bytes, received_bytes,
        "Wire roundtrip should preserve raw bytes"
    );

    // Reconstruct OlmMessage from received bytes
    let reconstructed =
        OlmMessage::from_parts(msg_type, &received_bytes).expect("Should reconstruct OlmMessage");

    // Alice decrypts the reconstructed message
    let pre_key = match reconstructed {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey"),
    };

    let InboundCreationResult {
        session: _,
        plaintext: decrypted,
    } = alice
        .create_inbound_session(bob_identity_key, &pre_key)
        .unwrap();

    assert_eq!(
        String::from_utf8(decrypted).unwrap(),
        plaintext,
        "Wire format roundtrip should preserve plaintext"
    );
}

// ── Megolm Tests ─────────────────────────────────────────────

#[test]
fn megolm_encrypt_decrypt_roundtrip() {
    // Sender creates an outbound session and encrypts
    let mut outbound = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key = outbound.session_key();
    let session_id = outbound.session_id();

    let plaintext = "Hello encrypted channel!";
    let message = outbound.encrypt(plaintext.as_bytes());
    let ciphertext_b64 = message.to_base64();

    // Receiver creates an inbound session from the shared session key
    let mut inbound = InboundGroupSession::new(&session_key, MegolmSessionConfig::version_2());
    assert_eq!(
        inbound.session_id(),
        session_id,
        "Inbound session_id should match outbound session_id"
    );

    // Receiver decrypts
    let received: MegolmMessage = ciphertext_b64.as_str().try_into().unwrap();
    let decrypted = inbound.decrypt(&received).unwrap();
    assert_eq!(
        String::from_utf8(decrypted.plaintext).unwrap(),
        plaintext,
        "Decrypted plaintext should match original"
    );
    assert_eq!(decrypted.message_index, 0, "First message should have index 0");
}

#[test]
fn megolm_multiple_messages_same_session() {
    let mut outbound = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key = outbound.session_key();
    let mut inbound = InboundGroupSession::new(&session_key, MegolmSessionConfig::version_2());

    let messages = [
        "First message in the channel",
        "Second message with more content",
        "Third message to verify sequential decryption",
        "Fourth message keeps going",
        "Fifth and final test message",
    ];

    for (idx, original) in messages.iter().enumerate() {
        let encrypted = outbound.encrypt(original.as_bytes());
        let ciphertext_b64 = encrypted.to_base64();

        let received: MegolmMessage = ciphertext_b64.as_str().try_into().unwrap();
        let decrypted = inbound.decrypt(&received).unwrap();

        assert_eq!(
            String::from_utf8(decrypted.plaintext).unwrap(),
            *original,
            "Message {} should decrypt correctly",
            idx
        );
        assert_eq!(
            decrypted.message_index, idx as u32,
            "Message index should be {}",
            idx
        );
    }
}

#[test]
fn megolm_different_senders_same_channel() {
    // Simulate two different users sending to the same channel
    // Each has their own outbound session

    // Sender A
    let mut outbound_a = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key_a = outbound_a.session_key();
    let session_id_a = outbound_a.session_id();

    // Sender B
    let mut outbound_b = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key_b = outbound_b.session_key();
    let session_id_b = outbound_b.session_id();

    // Session IDs should be different (different Ed25519 keypairs)
    assert_ne!(
        session_id_a, session_id_b,
        "Different senders should have different session IDs"
    );

    // Receiver creates inbound sessions for both senders
    let mut inbound_a =
        InboundGroupSession::new(&session_key_a, MegolmSessionConfig::version_2());
    let mut inbound_b =
        InboundGroupSession::new(&session_key_b, MegolmSessionConfig::version_2());

    // Sender A sends a message
    let msg_a = "Hello from sender A";
    let encrypted_a = outbound_a.encrypt(msg_a.as_bytes());
    let ct_a = encrypted_a.to_base64();

    // Sender B sends a message
    let msg_b = "Hello from sender B";
    let encrypted_b = outbound_b.encrypt(msg_b.as_bytes());
    let ct_b = encrypted_b.to_base64();

    // Decrypt A's message with A's inbound session
    let received_a: MegolmMessage = ct_a.as_str().try_into().unwrap();
    let decrypted_a = inbound_a.decrypt(&received_a).unwrap();
    assert_eq!(
        String::from_utf8(decrypted_a.plaintext).unwrap(),
        msg_a,
        "Should decrypt sender A's message correctly"
    );

    // Decrypt B's message with B's inbound session
    let received_b: MegolmMessage = ct_b.as_str().try_into().unwrap();
    let decrypted_b = inbound_b.decrypt(&received_b).unwrap();
    assert_eq!(
        String::from_utf8(decrypted_b.plaintext).unwrap(),
        msg_b,
        "Should decrypt sender B's message correctly"
    );

    // Cross-decryption should fail: A's ciphertext with B's session
    let received_a_again: MegolmMessage = ct_a.as_str().try_into().unwrap();
    let cross_result = inbound_b.decrypt(&received_a_again);
    assert!(
        cross_result.is_err(),
        "Decrypting sender A's message with sender B's session should fail"
    );
}

#[test]
fn megolm_session_key_base64_roundtrip() {
    // Verify that session key can be serialized to base64 and back
    let outbound = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key = outbound.session_key();
    let session_id = outbound.session_id();

    // Serialize to base64 (as it would be sent over the wire)
    let key_b64 = session_key.to_base64();
    assert!(
        !key_b64.is_empty(),
        "Session key base64 should not be empty"
    );

    // Deserialize back
    let restored_key = SessionKey::from_base64(&key_b64)
        .expect("Should parse session key from base64");

    // Create inbound from restored key -- session IDs should match
    let inbound =
        InboundGroupSession::new(&restored_key, MegolmSessionConfig::version_2());
    assert_eq!(
        inbound.session_id(),
        session_id,
        "Session ID from restored key should match original"
    );
}

#[test]
fn megolm_serialization_roundtrip() {
    // WHY: vodozemac pickle() is a safe crypto serialization format, not Python pickle.
    // Verify outbound session can be serialized and restored.
    let mut outbound = GroupSession::new(MegolmSessionConfig::version_2());
    let session_id = outbound.session_id();

    // Encrypt a message to advance the ratchet
    let _ = outbound.encrypt(b"before serialization");

    // WHY: Use a non-zero key to verify serialization works with realistic keys.
    // Production uses a random key from the OS keychain (get_or_create_serialization_key).
    let ser_key = *b"test_serialization_key_32bytes!!";
    let serialized = outbound.pickle().encrypt(&ser_key);
    let restored_data =
        vodozemac::megolm::GroupSessionPickle::from_encrypted(&serialized, &ser_key)
            .expect("Should restore outbound session");
    let mut restored = GroupSession::from_pickle(restored_data);

    assert_eq!(
        restored.session_id(),
        session_id,
        "Restored session should have the same session_id"
    );

    // The restored session should be able to encrypt and have the correct ratchet state
    let session_key = restored.session_key();
    let mut inbound =
        InboundGroupSession::new(&session_key, MegolmSessionConfig::version_2());

    let msg = "after restore";
    let encrypted = restored.encrypt(msg.as_bytes());
    let received: MegolmMessage = encrypted.to_base64().as_str().try_into().unwrap();
    let decrypted = inbound.decrypt(&received).unwrap();
    assert_eq!(
        String::from_utf8(decrypted.plaintext).unwrap(),
        msg,
        "Should decrypt message from restored session"
    );
}

// ── Safety Number Tests ─────────────────────────────────────

#[test]
fn safety_number_is_deterministic_regardless_of_key_order() {
    let alice_key = "AliceIdentityKeyBase64AAAAAAAAAAAAAAAAAA==";
    let bob_key = "BobIdentityKeyBase64BBBBBBBBBBBBBBBBBBBB==";

    // Alice computes: (her key, Bob's key)
    let alice_sees = generate_safety_number(alice_key, bob_key);
    // Bob computes: (his key, Alice's key) — reversed order
    let bob_sees = generate_safety_number(bob_key, alice_key);

    assert_eq!(
        alice_sees, bob_sees,
        "Both users must generate the same safety number regardless of argument order"
    );
}

#[test]
fn safety_number_format_is_15_groups_of_5_digits() {
    let key_a = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let key_b = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    let number = generate_safety_number(key_a, key_b);
    let groups: Vec<&str> = number.split(' ').collect();

    assert_eq!(groups.len(), 15, "Should have exactly 15 groups");
    for (i, group) in groups.iter().enumerate() {
        assert_eq!(
            group.len(),
            5,
            "Group {i} should be exactly 5 digits, got '{group}'"
        );
        assert!(
            group.chars().all(|c| c.is_ascii_digit()),
            "Group {i} should contain only digits, got '{group}'"
        );
    }
}

#[test]
fn safety_number_differs_for_different_key_pairs() {
    let key_a = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let key_b = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let key_c = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    let number_ab = generate_safety_number(key_a, key_b);
    let number_ac = generate_safety_number(key_a, key_c);

    assert_ne!(
        number_ab, number_ac,
        "Different key pairs should produce different safety numbers"
    );
}

#[test]
fn safety_number_with_real_olm_keys() {
    // WHY: Verify safety numbers work with actual vodozemac identity keys.
    let alice = Account::new();
    let bob = Account::new();

    let alice_key = alice.curve25519_key().to_base64();
    let bob_key = bob.curve25519_key().to_base64();

    let alice_sees = generate_safety_number(&alice_key, &bob_key);
    let bob_sees = generate_safety_number(&bob_key, &alice_key);

    assert_eq!(
        alice_sees, bob_sees,
        "Safety numbers from real Olm keys must match regardless of order"
    );

    // Verify format
    let groups: Vec<&str> = alice_sees.split(' ').collect();
    assert_eq!(groups.len(), 15, "Should have 15 groups");
}

// ── getrandom Key Generation Tests ──────────────────────────
// WHY: Verify the dep bump migration (rand::rng() → getrandom::fill())
// produces safe cryptographic key material matching store.rs:L66-L71 usage.

#[test]
fn test_getrandom_produces_nonzero_key() {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("getrandom should not fail on this platform");

    // Key should not be all zeros (probability ~2^-256)
    assert_ne!(key, [0u8; 32], "Generated key should not be all zeros");
    assert_eq!(key.len(), 32, "Key should be exactly 32 bytes");
}

#[test]
fn test_getrandom_produces_unique_keys() {
    let mut key1 = [0u8; 32];
    let mut key2 = [0u8; 32];
    getrandom::fill(&mut key1).expect("getrandom fill key1");
    getrandom::fill(&mut key2).expect("getrandom fill key2");

    // Two consecutive 256-bit random keys should differ (probability ~1 - 2^-256)
    assert_ne!(key1, key2, "Two random keys should not be identical");
}

#[test]
fn test_getrandom_key_hex_roundtrip() {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).expect("getrandom fill");

    // Matches actual usage: hex::encode in store.rs get_or_create_db_key()
    let hex_key = hex::encode(key);
    assert_eq!(hex_key.len(), 64, "Hex-encoded 32-byte key should be 64 chars");

    // Mirror the production conversion in olm.rs:38-41
    let decoded = hex::decode(&hex_key).expect("hex decode should succeed");
    let roundtrip_key: [u8; 32] = decoded.try_into().expect("decoded key should be exactly 32 bytes");
    assert_eq!(roundtrip_key, key, "Hex roundtrip should preserve key bytes");
}

// ── Integration Tests: Full Encrypt→Transit→Decrypt Cycle ───

#[test]
fn test_olm_json_envelope_roundtrip() {
    // WHY: Proves the exact wire format the frontend uses for DMs survives
    // a full JSON serialize → deserialize → decrypt cycle.

    // Alice creates an account and publishes one-time keys
    let mut alice = Account::new();
    alice.generate_one_time_keys(1);
    let alice_identity_key = alice.curve25519_key();
    let alice_otk = *alice.one_time_keys().values().next().unwrap();
    alice.mark_keys_as_published();

    // Bob creates an account and outbound session to Alice
    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();
    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk,
    );

    // Bob encrypts a DM
    let original = "Hello Alice!";
    let encrypted = bob_session.encrypt(original.as_bytes());
    let (message_type, ciphertext_bytes) = encrypted.to_parts();

    // Build JSON envelope — mirrors the `content` field stored in the DB
    let envelope = serde_json::json!({
        "message_type": message_type,
        "ciphertext": BASE64.encode(&ciphertext_bytes),
    });
    let wire_json = serde_json::to_string(&envelope)
        .expect("JSON serialization should succeed");

    // --- transit boundary (DB write → DB read) ---

    // Parse JSON back
    let parsed: serde_json::Value = serde_json::from_str(&wire_json)
        .expect("JSON deserialization should succeed");
    let recv_msg_type = parsed["message_type"]
        .as_u64()
        .expect("message_type should be a number") as usize;
    let recv_ciphertext_b64 = parsed["ciphertext"]
        .as_str()
        .expect("ciphertext should be a string");

    // Alice decodes base64 and reconstructs OlmMessage
    let recv_bytes = BASE64.decode(recv_ciphertext_b64)
        .expect("Base64 decode should succeed");
    let olm_message = OlmMessage::from_parts(recv_msg_type, &recv_bytes)
        .expect("Should reconstruct OlmMessage from parts");

    let pre_key = match olm_message {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey message for first envelope"),
    };

    let InboundCreationResult {
        session: _,
        plaintext,
    } = alice
        .create_inbound_session(bob_identity_key, &pre_key)
        .expect("Alice should create inbound session from envelope");

    assert_eq!(
        String::from_utf8(plaintext).unwrap(),
        original,
        "DM plaintext should survive full JSON envelope roundtrip"
    );
}

#[test]
fn test_megolm_json_envelope_roundtrip() {
    // WHY: Proves the exact wire format the frontend uses for channel messages
    // survives a full JSON serialize → deserialize → decrypt cycle.

    let mut outbound = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key = outbound.session_key();
    let session_id = outbound.session_id();

    let mut inbound = InboundGroupSession::new(&session_key, MegolmSessionConfig::version_2());

    // Sender encrypts a channel message
    let original = "Secret channel message";
    let megolm_msg = outbound.encrypt(original.as_bytes());
    let ciphertext_b64 = megolm_msg.to_base64();

    // Build JSON envelope — mirrors the `content` field stored in the DB
    let envelope = serde_json::json!({
        "session_id": session_id,
        "ciphertext": ciphertext_b64,
    });
    let wire_json = serde_json::to_string(&envelope)
        .expect("JSON serialization should succeed");

    // --- transit boundary (DB write → DB read) ---

    // Parse JSON back
    let parsed: serde_json::Value = serde_json::from_str(&wire_json)
        .expect("JSON deserialization should succeed");
    let recv_session_id = parsed["session_id"]
        .as_str()
        .expect("session_id should be a string");
    let recv_ciphertext_b64 = parsed["ciphertext"]
        .as_str()
        .expect("ciphertext should be a string");

    // Verify session_id survived transit
    assert_eq!(
        recv_session_id, session_id,
        "session_id should survive JSON roundtrip"
    );

    // Receiver reconstructs MegolmMessage from base64 and decrypts
    let received: MegolmMessage = recv_ciphertext_b64
        .try_into()
        .expect("Should parse MegolmMessage from base64");
    let decrypted = inbound
        .decrypt(&received)
        .expect("Receiver should decrypt channel message from envelope");

    assert_eq!(
        String::from_utf8(decrypted.plaintext).unwrap(),
        original,
        "Channel plaintext should survive full JSON envelope roundtrip"
    );
    assert_eq!(
        decrypted.message_index, 0,
        "First message should have index 0"
    );
}

#[test]
fn test_olm_bidirectional_conversation_10_messages() {
    // WHY: Proves that alternating senders over an extended conversation
    // all decrypt correctly through the base64 wire format, and that
    // message_type transitions from PreKey (0) to Normal (1) after handshake.

    // Set up Alice and Bob
    let mut alice = Account::new();
    alice.generate_one_time_keys(1);
    let alice_identity_key = alice.curve25519_key();
    let alice_otk = *alice.one_time_keys().values().next().unwrap();
    alice.mark_keys_as_published();

    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();

    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk,
    );

    // Bob sends the first (pre-key) message to establish session
    let first_msg = "Hey Alice, starting our conversation";
    let encrypted_first = bob_session.encrypt(first_msg.as_bytes());
    let (first_type, first_ct) = encrypted_first.to_parts();
    assert_eq!(first_type, 0, "First message from Bob should be PreKey type (0)");

    // Alice receives via wire format and creates inbound session
    let wire_b64 = BASE64.encode(&first_ct);
    let recv_bytes = BASE64.decode(&wire_b64).unwrap();
    let olm_msg = OlmMessage::from_parts(first_type, &recv_bytes).unwrap();
    let pre_key = match olm_msg {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey for session establishment"),
    };
    let InboundCreationResult {
        session: mut alice_session,
        plaintext: first_plaintext,
    } = alice
        .create_inbound_session(bob_identity_key, &pre_key)
        .unwrap();
    assert_eq!(
        String::from_utf8(first_plaintext).unwrap(),
        first_msg,
        "First message should decrypt correctly"
    );

    // Conversation: alternate 5 messages each (messages 2-10, first was #1)
    let conversation = [
        ("alice", "Hi Bob! Good to hear from you."),
        ("bob", "How's the E2EE integration going?"),
        ("alice", "Great, the vodozemac primitives are solid."),
        ("bob", "Did you test the JSON envelope format?"),
        ("alice", "Yes, base64 roundtrip works perfectly."),
        ("bob", "What about message ordering?"),
        ("alice", "Ratchet state advances correctly each time."),
        ("bob", "Excellent. Let's ship it."),
        ("alice", "Agreed. Merging the PR now."),
    ];

    for (i, (sender, content)) in conversation.iter().enumerate() {
        if *sender == "bob" {
            // Bob encrypts, sends through wire format, Alice decrypts
            let encrypted = bob_session.encrypt(content.as_bytes());
            let (msg_type, ct_bytes) = encrypted.to_parts();

            // After the first PreKey, all Bob messages should be Normal (1)
            assert_eq!(
                msg_type, 1,
                "Bob's message {} should be Normal type (1)",
                i + 2
            );

            let wire = BASE64.encode(&ct_bytes);
            let recv = BASE64.decode(&wire).unwrap();
            let olm = OlmMessage::from_parts(msg_type, &recv).unwrap();
            let decrypted_bytes = alice_session
                .decrypt(&olm)
                .expect("Alice should decrypt Bob's message");
            assert_eq!(
                String::from_utf8(decrypted_bytes).unwrap(),
                *content,
                "Message {} from Bob should match",
                i + 2
            );
        } else {
            // Alice encrypts, sends through wire format, Bob decrypts
            let encrypted = alice_session.encrypt(content.as_bytes());
            let (msg_type, ct_bytes) = encrypted.to_parts();
            let wire = BASE64.encode(&ct_bytes);
            let recv = BASE64.decode(&wire).unwrap();
            let olm = OlmMessage::from_parts(msg_type, &recv).unwrap();
            let decrypted_bytes = bob_session
                .decrypt(&olm)
                .expect("Bob should decrypt Alice's message");
            assert_eq!(
                String::from_utf8(decrypted_bytes).unwrap(),
                *content,
                "Message {} from Alice should match",
                i + 2
            );
        }
    }
}

#[test]
fn test_olm_session_not_reusable_for_different_recipient() {
    // WHY: Proves that a pre-key message encrypted for Alice cannot be used
    // by Charlie to create an inbound session — wrong identity key is rejected.

    // Alice, Bob, Charlie each create accounts
    let mut alice = Account::new();
    alice.generate_one_time_keys(1);
    let alice_identity_key = alice.curve25519_key();
    let alice_otk = *alice.one_time_keys().values().next().unwrap();
    alice.mark_keys_as_published();

    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();

    let mut charlie = Account::new();
    charlie.generate_one_time_keys(1);

    // Bob creates a session targeting Alice and encrypts a message
    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk,
    );
    let encrypted = bob_session.encrypt(b"Secret for Alice only");
    let (msg_type, ct_bytes) = encrypted.to_parts();

    // Simulate wire transfer
    let wire_b64 = BASE64.encode(&ct_bytes);
    let recv_bytes = BASE64.decode(&wire_b64).unwrap();

    let olm_msg = OlmMessage::from_parts(msg_type, &recv_bytes).unwrap();
    let pre_key = match olm_msg {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey message"),
    };

    // Charlie tries to create an inbound session with the message meant for Alice.
    // This must fail because the pre-key message is bound to Alice's identity key,
    // and Charlie provides Bob's identity key expecting it to match his own account.
    let charlie_result = charlie.create_inbound_session(bob_identity_key, &pre_key);
    assert!(
        charlie_result.is_err(),
        "Charlie must NOT create an inbound session from a message encrypted for Alice"
    );
}

// ── Adversarial / Edge-Case Tests ───────────────────────────

#[test]
fn test_olm_wrong_session_decryption_fails() {
    // WHY: Proves that Olm sessions are isolated — a message encrypted for one
    // session cannot be decrypted by a different session, even if both target
    // the same recipient.

    // Alice creates an account with two one-time keys (one for Bob, one for Charlie)
    let mut alice = Account::new();
    alice.generate_one_time_keys(2);
    let alice_identity_key = alice.curve25519_key();
    let mut otk_iter = alice.one_time_keys().into_values();
    let alice_otk_for_bob = otk_iter.next().expect("Alice should have a first one-time key");
    let alice_otk_for_charlie = otk_iter.next().expect("Alice should have a second one-time key");
    alice.mark_keys_as_published();

    // Bob creates an outbound session to Alice and encrypts a message
    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();
    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk_for_bob,
    );
    let bob_msg = bob_session.encrypt(b"Hello from Bob");
    let (bob_msg_type, bob_ct_bytes) = bob_msg.to_parts();

    // Alice creates an inbound session from Bob's pre-key message (should succeed)
    let bob_olm = OlmMessage::from_parts(bob_msg_type, &bob_ct_bytes)
        .expect("Should parse Bob's OlmMessage");
    let bob_pre_key = match bob_olm {
        OlmMessage::PreKey(m) => m,
        OlmMessage::Normal(_) => panic!("Expected PreKey from Bob"),
    };
    let InboundCreationResult {
        session: mut alice_bob_session,
        plaintext: bob_plaintext,
    } = alice
        .create_inbound_session(bob_identity_key, &bob_pre_key)
        .expect("Alice should create inbound session from Bob");
    assert_eq!(
        String::from_utf8(bob_plaintext).unwrap(),
        "Hello from Bob",
        "Alice should decrypt Bob's initial message"
    );

    // Charlie creates a DIFFERENT outbound session to Alice and encrypts a message
    let charlie = Account::new();
    let mut charlie_session = charlie.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk_for_charlie,
    );
    let charlie_msg = charlie_session.encrypt(b"Hello from Charlie");

    // Try to decrypt Charlie's message with Alice-Bob session — must fail
    let charlie_decrypt_result = alice_bob_session.decrypt(&charlie_msg);
    assert!(
        charlie_decrypt_result.is_err(),
        "Decrypting Charlie's message with Alice-Bob session should fail (session isolation)"
    );
}

#[test]
fn test_olm_corrupt_ciphertext_graceful_error() {
    // WHY: Verifies that tampering with ciphertext bytes produces a clean error,
    // not a panic or undefined behavior.

    let mut alice = Account::new();
    alice.generate_one_time_keys(1);
    let alice_identity_key = alice.curve25519_key();
    let alice_otk = *alice.one_time_keys().values().next().unwrap();
    alice.mark_keys_as_published();

    let bob = Account::new();
    let bob_identity_key = bob.curve25519_key();
    let mut bob_session = bob.create_outbound_session(
        SessionConfig::version_2(),
        alice_identity_key,
        alice_otk,
    );

    // Encrypt a real message
    let encrypted = bob_session.encrypt(b"Legitimate message");
    let (message_type, ciphertext_bytes) = encrypted.to_parts();

    // Tamper with the ciphertext: flip one byte in the middle
    let mut tampered = ciphertext_bytes.clone();
    let mid = tampered.len() / 2;
    tampered[mid] ^= 0xFF;

    // Reconstruct OlmMessage from tampered bytes — parsing may or may not succeed
    let parse_result = OlmMessage::from_parts(message_type, &tampered);
    if let Ok(tampered_msg) = parse_result {
        // If it parsed, Alice should fail to decrypt or fail to create a session
        match tampered_msg {
            OlmMessage::PreKey(pre_key) => {
                let session_result =
                    alice.create_inbound_session(bob_identity_key, &pre_key);
                assert!(
                    session_result.is_err(),
                    "Tampered pre-key message should fail inbound session creation"
                );
            }
            OlmMessage::Normal(normal) => {
                // Alice needs an established session first to attempt normal decryption.
                // Create the real session first, then try the tampered normal message.
                let real_msg = OlmMessage::from_parts(message_type, &ciphertext_bytes)
                    .expect("Original message should parse");
                let real_pre_key = match real_msg {
                    OlmMessage::PreKey(m) => m,
                    OlmMessage::Normal(_) => panic!("Expected PreKey for session setup"),
                };
                let InboundCreationResult {
                    session: mut alice_session,
                    ..
                } = alice
                    .create_inbound_session(bob_identity_key, &real_pre_key)
                    .expect("Session from real message should succeed");

                let decrypt_result =
                    alice_session.decrypt(&OlmMessage::Normal(normal));
                assert!(
                    decrypt_result.is_err(),
                    "Tampered normal message should fail decryption"
                );
            }
        }
    }
    // If from_parts itself returned Err, that is also a graceful failure — no panic occurred.
}

#[test]
fn test_olm_invalid_prekey_message_graceful_error() {
    // WHY: Verifies that feeding garbage bytes into the Olm message parser
    // and session creation does not panic — errors are returned gracefully.

    let mut alice = Account::new();
    alice.generate_one_time_keys(1);

    // Fabricate random bytes that are NOT a valid pre-key message
    let garbage_bytes: Vec<u8> = vec![0xDE; 32];

    // Attempt to parse as a PreKey OlmMessage (message_type 0)
    let parse_result = OlmMessage::from_parts(0, &garbage_bytes);
    if let Ok(olm_msg) = parse_result {
        match olm_msg {
            OlmMessage::PreKey(pre_key) => {
                // Use a random identity key — create a throwaway account for it
                let random_sender = Account::new();
                let random_identity_key = random_sender.curve25519_key();

                let session_result =
                    alice.create_inbound_session(random_identity_key, &pre_key);
                assert!(
                    session_result.is_err(),
                    "Creating inbound session from garbage pre-key should fail gracefully"
                );
            }
            OlmMessage::Normal(_) => {
                // Parsed as Normal instead of PreKey — unexpected but not a panic.
                // This is acceptable: the point is no panic occurred.
            }
        }
    }
    // If from_parts returned Err, that is also graceful — no panic.
}

#[test]
fn test_megolm_corrupt_ciphertext_graceful_error() {
    // WHY: Verifies that corrupted Megolm ciphertext produces an error,
    // not a panic, whether at the parsing or decryption stage.

    let mut outbound = GroupSession::new(MegolmSessionConfig::version_2());
    let session_key = outbound.session_key();
    let mut inbound = InboundGroupSession::new(&session_key, MegolmSessionConfig::version_2());

    let message = outbound.encrypt(b"Real channel message");
    let mut ciphertext_b64 = message.to_base64();

    // Tamper with the base64 string: replace the last 4 characters
    let len = ciphertext_b64.len();
    assert!(
        len >= 4,
        "Ciphertext base64 should be at least 4 characters for tampering"
    );
    ciphertext_b64.replace_range((len - 4).., "XXXX");

    // Try to parse the tampered base64 as a MegolmMessage
    let parse_result: Result<MegolmMessage, _> = ciphertext_b64.as_str().try_into();
    match parse_result {
        Err(_) => {
            // Parsing failed — graceful error, no panic.
        }
        Ok(tampered_msg) => {
            // If it somehow parsed, decryption must fail
            let decrypt_result = inbound.decrypt(&tampered_msg);
            assert!(
                decrypt_result.is_err(),
                "Decrypting tampered Megolm ciphertext should fail"
            );
        }
    }
}

