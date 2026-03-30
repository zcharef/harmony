# ADR-022: No std::sync::Mutex in Async Code

**Status:** Accepted
**Date:** 2026-03-16

## Context

`std::sync::Mutex` held across an `.await` point causes deadlocks in async Rust:

```rust
// BAD: std::sync::Mutex held across await — DEADLOCK
use std::sync::Mutex;

let cache = Arc::new(Mutex::new(HashMap::new()));

async fn get_or_fetch(cache: Arc<Mutex<HashMap<String, String>>>, key: &str) -> String {
    let mut guard = cache.lock().unwrap();
    if let Some(val) = guard.get(key) {
        return val.clone();
    }
    // guard is still held here!
    let val = fetch_from_db(key).await; // <-- .await while holding std Mutex
    guard.insert(key.to_string(), val.clone());
    val
    // If the executor parks this task and schedules another task
    // that also tries to lock this Mutex on the same thread — deadlock.
}
```

The Tokio runtime is single-threaded per core. If a task holds a `std::sync::Mutex` and yields at `.await`, the executor may schedule another task on the same thread that tries to acquire the same lock — permanent deadlock.

## Decision

Use **`tokio::sync::Mutex`** when a lock must be held across `.await` points. Use **`DashMap`** for concurrent hash maps that don't need lock-across-await semantics.

```rust
// GOOD: tokio Mutex is await-aware — yields instead of blocking the thread
use tokio::sync::Mutex;

let cache = Arc::new(Mutex::new(HashMap::new()));

async fn get_or_fetch(cache: Arc<Mutex<HashMap<String, String>>>, key: &str) -> String {
    let mut guard = cache.lock().await; // .await on the lock itself
    if let Some(val) = guard.get(key) {
        return val.clone();
    }
    let val = fetch_from_db(key).await;
    guard.insert(key.to_string(), val.clone());
    val
}
```

**Exceptions — these are allowed:**
- `std::sync::OnceLock` — initialized once, never held across await
- `std::sync::LazyLock` — initialized once, never held across await
- `std::sync::Mutex` in non-async code (e.g., CLI tools, build scripts)

## Consequences

**Positive:**
- Eliminates an entire class of async deadlocks
- `tokio::sync::Mutex` cooperates with the executor — yields instead of blocking
- `DashMap` provides lock-free concurrent reads for hot paths

**Negative:**
- `tokio::sync::Mutex` is slightly slower than `std::sync::Mutex` for non-contended cases
- Developers must remember to use `tokio::sync` in async contexts (enforcement test catches mistakes)
- `DashMap` adds a dependency (justified by performance characteristics)

## Enforcement

- **Enforcement test:** `tests/rust_patterns_test.rs` scans all `.rs` files in `src/` for `std::sync::Mutex` and `std::sync::RwLock` — test fails if found (with an allowlist for `OnceLock` and `LazyLock`)
- **Code review:** PRs introducing synchronization primitives require justification for the chosen type
