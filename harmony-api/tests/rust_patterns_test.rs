#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Rust patterns enforcement tests (static analysis).
//!
//! These tests scan source files for anti-patterns that would pass compilation
//! but violate project conventions. They act as a safety net beyond Clippy lints.
//!
//! Rules enforced:
//! 1. No `std::sync::Mutex`/`RwLock` in async code (deadlock risk)
//! 2. No `std::env::var` outside `config.rs` (typed config only)
//! 3. No `process::exit`/`process::abort` (use error propagation)
//! 4. No wildcard `_ =>` in domain error mapping (forces handling new variants)
//! 5. No `println!`/`eprintln!`/`dbg!`/`print!` in src (use tracing)
//! 6. Request DTOs must use `deny_unknown_fields`
//! 7. Request DTOs must not contain timestamp fields
//! 8. DTOs must use `rename_all = "camelCase"`
//! 9. No runtime SQL queries (must use compile-time macros)
//! 10. SQL aggregates must be explicitly cast
//! 11. No `DELETE FROM messages` (soft-delete only)
//!
//! Approach: Source-level text scanning (fast, no AST parsing needed).

use std::fs;
use std::path::{Path, PathBuf};

/// Collects all `.rs` files under a directory recursively.
fn collect_rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !dir.exists() {
        return files;
    }

    fn visit_dir(dir: &Path, files: &mut Vec<PathBuf>) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    visit_dir(&path, files);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    files.push(path);
                }
            }
        }
    }

    visit_dir(dir, &mut files);
    files
}

// ─── Test a) ────────────────────────────────────────────────────────────────

/// Test: No `std::sync::Mutex` or `std::sync::RwLock` in async code.
///
/// WHY: `std::sync::Mutex` held across `.await` points causes deadlocks.
/// Use `tokio::sync::Mutex`, `tokio::sync::RwLock`, or lock-free structures
/// like `DashMap` instead.
///
/// Allows: `OnceLock`, `LazyLock` (single-initialization, no deadlock risk).
#[test]
fn no_std_sync_mutex_in_async_code() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(!rust_files.is_empty(), "No Rust files found in src/");

    let forbidden = &["std::sync::Mutex", "std::sync::RwLock"];
    let allowed = &["OnceLock", "LazyLock"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            for pattern in forbidden {
                if line.contains(pattern) {
                    // Allow OnceLock and LazyLock (safe in async)
                    let is_allowed = allowed.iter().any(|a| line.contains(a));
                    if !is_allowed {
                        violations.push(format!(
                            "  {}:{} - found '{}'\n    > {}",
                            file.display(),
                            line_num + 1,
                            pattern,
                            trimmed
                        ));
                    }
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nAsync Safety Violation: std::sync::Mutex/RwLock in async code!\n\n\
            std::sync::Mutex held across .await points causes deadlocks.\n\
            Use tokio::sync::Mutex, tokio::sync::RwLock, or DashMap instead.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace std::sync::Mutex with tokio::sync::Mutex (or DashMap for concurrent maps).\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test b) ────────────────────────────────────────────────────────────────

/// Test: No `std::env::var` outside `config.rs`.
///
/// WHY: All environment variables must be read through the typed Config struct
/// to ensure validation, defaults, and secret wrapping. Ad-hoc `env::var` calls
/// bypass these safety nets.
#[test]
fn no_env_var_outside_config() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(!rust_files.is_empty(), "No Rust files found in src/");

    let forbidden = &["env::var", "std::env::var"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        // Skip config.rs — it's the only file allowed to read env vars
        if file.ends_with("config.rs") {
            continue;
        }

        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            // Skip env!() macro (compile-time, not runtime)
            if trimmed.contains("env!(") {
                continue;
            }

            for pattern in forbidden {
                if line.contains(pattern) {
                    violations.push(format!(
                        "  {}:{} - found '{}'\n    > {}",
                        file.display(),
                        line_num + 1,
                        pattern,
                        trimmed
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nTyped Config Violation: env::var used outside config.rs!\n\n\
            All environment variables must be read through the Config struct.\n\
            Ad-hoc env::var bypasses validation, defaults, and secret wrapping.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Add the env var to Config struct in src/config.rs and access via config.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test c) ────────────────────────────────────────────────────────────────

/// Test: No `process::exit` or `process::abort` in src.
///
/// WHY: Direct process termination bypasses graceful shutdown, loses in-flight
/// requests, and prevents cleanup. Use error propagation instead.
#[test]
fn no_process_exit() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(!rust_files.is_empty(), "No Rust files found in src/");

    let forbidden = &["process::exit", "process::abort"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            for pattern in forbidden {
                if line.contains(pattern) {
                    violations.push(format!(
                        "  {}:{} - found '{}'\n    > {}",
                        file.display(),
                        line_num + 1,
                        pattern,
                        trimmed
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nProcess Control Violation: process::exit or process::abort found!\n\n\
            Direct process termination bypasses graceful shutdown and loses in-flight requests.\n\
            Use anyhow::bail!(), return Err(...), or let the panic handler run instead.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace with proper error propagation.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test d) ────────────────────────────────────────────────────────────────

/// Test: No wildcard `_ =>` in domain error mapping in `api/errors.rs`.
///
/// WHY: A wildcard match on `DomainError` silently swallows new error variants.
/// Every `DomainError` variant must be explicitly mapped to an HTTP status code
/// so the compiler forces us to handle new variants.
#[test]
fn no_wildcard_in_domain_error_mapping() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let errors_file = Path::new(manifest_dir).join("src/api/errors.rs");

    let content = fs::read_to_string(&errors_file)
        .unwrap_or_else(|e| panic!("Failed to read {}: {}", errors_file.display(), e));

    let mut violations: Vec<String> = Vec::new();
    let mut in_match_block = false;

    for (line_num, line) in content.lines().enumerate() {
        let trimmed = line.trim();

        // Skip comments
        if trimmed.starts_with("//") {
            continue;
        }

        // Track match blocks (simple heuristic: lines with "match " keyword)
        if trimmed.contains("match ") {
            in_match_block = true;
        }

        if in_match_block && trimmed.starts_with("_ =>") {
            violations.push(format!(
                "  {}:{} - wildcard match arm in error mapping\n    > {}",
                errors_file.display(),
                line_num + 1,
                trimmed
            ));
        }

        // Close match block on closing brace (simple heuristic)
        if in_match_block && trimmed == "}" {
            in_match_block = false;
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nError Mapping Violation: Wildcard '_ =>' found in api/errors.rs!\n\n\
            Every DomainError variant must be explicitly mapped to an HTTP status code.\n\
            Wildcard matches silently swallow new variants added to DomainError.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace '_ =>' with explicit match arms for each DomainError variant.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test e) ────────────────────────────────────────────────────────────────

/// Test: No `println!`, `eprintln!`, `dbg!`, `print!` in src.
///
/// WHY: All output must go through `tracing` for structured, leveled logging.
/// Raw print statements bypass log aggregation and can leak sensitive data.
/// This is a backup for the Clippy `print_stdout`/`print_stderr` lints.
#[test]
fn no_println_in_src() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(!rust_files.is_empty(), "No Rust files found in src/");

    let forbidden = &["println!", "eprintln!", "eprint!", "dbg!", "print!"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        // Skip src/bin/ — CLI tools legitimately use stdout for output
        let path_str = file.to_string_lossy();
        if path_str.contains("/bin/") || path_str.contains("\\bin\\") {
            continue;
        }

        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            // Skip lines that are allow attributes for these lints
            if trimmed.contains("allow(") {
                continue;
            }

            for pattern in forbidden {
                if line.contains(pattern) {
                    // Avoid false positives: "eprint!" matching "eprintln!"
                    // and "print!" matching "println!" — check boundaries
                    if *pattern == "print!" && (line.contains("println!") || line.contains("eprint")) {
                        continue;
                    }

                    violations.push(format!(
                        "  {}:{} - found '{}'\n    > {}",
                        file.display(),
                        line_num + 1,
                        pattern,
                        trimmed
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nLogging Violation: Raw print macros found in src/!\n\n\
            All output must go through the `tracing` crate for structured logging.\n\
            Raw print statements bypass log aggregation and can leak sensitive data.\n\
            (src/bin/ is exempt — CLI tools legitimately use stdout)\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace with tracing::info!(), tracing::warn!(), tracing::error!(), etc.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test f) ────────────────────────────────────────────────────────────────

/// Test: Request DTOs with `Deserialize` must have `deny_unknown_fields`.
///
/// WHY: Without `deny_unknown_fields`, typos in request JSON are silently
/// ignored (e.g., `naame` instead of `name`). This makes debugging painful
/// and allows stale fields to go unnoticed.
#[test]
fn request_dtos_deny_unknown_fields() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dto_dir = Path::new(manifest_dir).join("src/api/dto");

    let rust_files: Vec<PathBuf> = collect_rust_files(&dto_dir)
        .into_iter()
        .filter(|f| f.file_name().is_some_and(|name| name != "mod.rs"))
        .collect();

    // No DTO files yet — passes trivially but catches future violations
    if rust_files.is_empty() {
        return;
    }

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            if trimmed.starts_with("pub struct ") {
                let struct_name = trimmed
                    .strip_prefix("pub struct ")
                    .and_then(|rest| rest.split(|c: char| !c.is_alphanumeric() && c != '_').next())
                    .unwrap_or("unknown");

                // Only check structs that follow request DTO naming conventions.
                // Response DTOs may also derive Deserialize (e.g., for testing)
                // but should NOT require deny_unknown_fields.
                let is_request_dto = struct_name.ends_with("Request")
                    || struct_name.ends_with("Input")
                    || struct_name.ends_with("Command")
                    || struct_name.starts_with("Create")
                    || struct_name.starts_with("Update");

                if !is_request_dto {
                    continue;
                }

                // Check if this struct derives Deserialize (it's a request DTO)
                let has_deserialize = (i.saturating_sub(5)..i)
                    .any(|j| lines.get(j).is_some_and(|l| l.contains("Deserialize")));

                if !has_deserialize {
                    continue;
                }

                // Check for deny_unknown_fields in the preceding attributes
                let has_deny = (i.saturating_sub(5)..i)
                    .any(|j| lines.get(j).is_some_and(|l| l.contains("deny_unknown_fields")));

                if !has_deny {
                    violations.push(format!(
                        "  {}:{} - `{}` has Deserialize but missing #[serde(deny_unknown_fields)]",
                        file.display(),
                        i + 1,
                        struct_name
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nDTO Safety Violation: Request DTOs without deny_unknown_fields!\n\n\
            Every request DTO (with Deserialize) must have #[serde(deny_unknown_fields)]\n\
            to reject typos and unknown fields in client requests.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Add #[serde(deny_unknown_fields)] to each request DTO struct.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test g) ────────────────────────────────────────────────────────────────

/// Test: Request DTOs must not contain timestamp fields.
///
/// WHY: Timestamps like `created_at`, `updated_at`, `edited_at`, `joined_at`
/// are server-generated. Clients must never send them. Allowing them in request
/// DTOs enables timestamp forgery.
#[test]
fn request_dtos_no_timestamp_fields() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dto_dir = Path::new(manifest_dir).join("src/api/dto");

    let rust_files: Vec<PathBuf> = collect_rust_files(&dto_dir)
        .into_iter()
        .filter(|f| f.file_name().is_some_and(|name| name != "mod.rs"))
        .collect();

    if rust_files.is_empty() {
        return;
    }

    let timestamp_fields = &["created_at", "updated_at", "edited_at", "joined_at"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();
        let mut current_struct: Option<(String, bool)> = None; // (name, is_request_dto)

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            // Track struct definitions
            if trimmed.starts_with("pub struct ") {
                let struct_name = trimmed
                    .strip_prefix("pub struct ")
                    .and_then(|rest| rest.split(|c: char| !c.is_alphanumeric() && c != '_').next())
                    .unwrap_or("unknown")
                    .to_string();

                // Check if it's a request DTO (has Deserialize)
                let is_request = (i.saturating_sub(5)..i)
                    .any(|j| lines.get(j).is_some_and(|l| l.contains("Deserialize")));

                current_struct = Some((struct_name, is_request));
            }

            // Check fields inside request structs
            if let Some((ref struct_name, true)) = current_struct {
                for field in timestamp_fields {
                    if trimmed.contains(&format!("pub {field}"))
                        || trimmed.contains(&format!("{field}:"))
                    {
                        violations.push(format!(
                            "  {}:{} - `{}` contains server-generated field '{}'\n    > {}",
                            file.display(),
                            i + 1,
                            struct_name,
                            field,
                            trimmed
                        ));
                    }
                }
            }

            // End of struct (simple heuristic)
            if trimmed == "}" {
                current_struct = None;
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nDTO Safety Violation: Request DTOs contain server-generated timestamp fields!\n\n\
            Fields like created_at, updated_at, edited_at, joined_at are server-generated.\n\
            Clients must never send them — including them in request DTOs enables forgery.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Remove timestamp fields from request DTOs. Only include them in response DTOs.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test h) ────────────────────────────────────────────────────────────────

/// Test: DTOs with Serialize or Deserialize must have `rename_all = "camelCase"`.
///
/// WHY: The API contract uses camelCase JSON keys. Without this attribute,
/// Rust's `snake_case` field names leak into the API, breaking `TypeScript` clients.
#[test]
fn dtos_use_camel_case() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dto_dir = Path::new(manifest_dir).join("src/api/dto");

    let rust_files: Vec<PathBuf> = collect_rust_files(&dto_dir)
        .into_iter()
        .filter(|f| f.file_name().is_some_and(|name| name != "mod.rs"))
        .collect();

    if rust_files.is_empty() {
        return;
    }

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            if trimmed.starts_with("pub struct ") {
                let struct_name = trimmed
                    .strip_prefix("pub struct ")
                    .and_then(|rest| rest.split(|c: char| !c.is_alphanumeric() && c != '_').next())
                    .unwrap_or("unknown");

                // Check if it has Serialize or Deserialize
                let has_serde = (i.saturating_sub(5)..i).any(|j| {
                    lines.get(j).is_some_and(|l| {
                        l.contains("Serialize") || l.contains("Deserialize")
                    })
                });

                if !has_serde {
                    continue;
                }

                // Check for rename_all = "camelCase"
                let has_camel = (i.saturating_sub(5)..i).any(|j| {
                    lines
                        .get(j)
                        .is_some_and(|l| l.contains("rename_all") && l.contains("camelCase"))
                });

                if !has_camel {
                    violations.push(format!(
                        "  {}:{} - `{}` has Serialize/Deserialize but missing #[serde(rename_all = \"camelCase\")]",
                        file.display(),
                        i + 1,
                        struct_name
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nDTO Convention Violation: DTOs without camelCase serialization!\n\n\
            Every DTO with Serialize or Deserialize must have:\n\
            #[serde(rename_all = \"camelCase\")]\n\n\
            This ensures the API contract uses camelCase keys as TypeScript clients expect.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Add #[serde(rename_all = \"camelCase\")] to each DTO struct.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test i) ────────────────────────────────────────────────────────────────

/// Test: No runtime SQL queries — must use compile-time macros.
///
/// WHY: `sqlx::query("...")` is a runtime string that skips compile-time SQL
/// verification. `sqlx::query!()` and `sqlx::query_as!()` are verified against
/// the database schema at compile time, catching typos and type mismatches.
#[test]
fn no_runtime_sql_queries() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let infra_dir = Path::new(manifest_dir).join("src/infra");

    let rust_files = collect_rust_files(&infra_dir);
    // infra dir may be sparse in early development
    if rust_files.is_empty() {
        return;
    }

    // Patterns for runtime SQL (without ! = not a macro)
    let runtime_patterns = &[
        "sqlx::query(",
        "sqlx::query_as(",
        "sqlx::query_scalar(",
        "sqlx::query_with(",
    ];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            // Allow explicitly annotated lines (infrastructure queries like ping/SET)
            if line.contains("allow: runtime-sql") {
                continue;
            }

            for pattern in runtime_patterns {
                if line.contains(pattern) {
                    // Make sure it's not a macro invocation (pattern followed by `!`)
                    // e.g., "sqlx::query!(" is fine, "sqlx::query(" is not
                    let macro_pattern = format!("{}!", pattern.trim_end_matches('('));
                    if line.contains(&macro_pattern) {
                        continue;
                    }

                    violations.push(format!(
                        "  {}:{} - runtime SQL query '{}'\n    > {}",
                        file.display(),
                        line_num + 1,
                        pattern,
                        trimmed
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nSQL Safety Violation: Runtime SQL queries found in infra/!\n\n\
            All SQL queries must use compile-time verified macros:\n\
            - sqlx::query!()    instead of sqlx::query()\n\
            - sqlx::query_as!() instead of sqlx::query_as()\n\n\
            Compile-time macros catch SQL typos and type mismatches at build time.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace runtime query calls with their macro equivalents.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test j) ────────────────────────────────────────────────────────────────

/// Test: SQL aggregates (SUM, AVG) must be explicitly cast.
///
/// WHY: `PostgreSQL`'s `SUM(bigint)` returns `NUMERIC`, not `bigint`.
/// Without an explicit `::BIGINT` cast, `SQLx` will fail to deserialize.
/// Pattern: `COALESCE(SUM(col)::BIGINT, 0) as "total!"`
#[test]
fn sql_aggregates_must_be_cast() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(!rust_files.is_empty(), "No Rust files found in src/");

    let aggregates = &["SUM(", "AVG("];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();

        for (line_num, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            for agg in aggregates {
                // Case-insensitive check for SQL aggregate functions
                let upper = line.to_uppercase();
                if let Some(agg_pos) = upper.find(agg) {
                    // Only check for :: cast AFTER the aggregate position,
                    // not before it (avoids false positive on Rust's `sqlx::query!`)
                    let after_agg = &line[agg_pos..];
                    let has_cast = after_agg.contains("::")
                        || lines
                            .get(line_num + 1)
                            .is_some_and(|next| next.contains("::"));

                    if !has_cast {
                        violations.push(format!(
                            "  {}:{} - SQL aggregate '{}' without explicit type cast (::)\n    > {}",
                            file.display(),
                            line_num + 1,
                            agg.trim_end_matches('('),
                            trimmed
                        ));
                    }
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nSQL Type Safety Violation: Uncast SQL aggregates found!\n\n\
            PostgreSQL SUM(bigint) returns NUMERIC, not bigint.\n\
            Always cast explicitly: COALESCE(SUM(col)::BIGINT, 0) as \"total!\"\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Add explicit type cast (::BIGINT, ::INT, etc.) after each aggregate.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test k) ────────────────────────────────────────────────────────────────

/// Test: No `DELETE FROM messages` in infra.
///
/// WHY: Messages should be soft-deleted (flagged), not hard-deleted.
/// Hard deletion loses audit trail and breaks message threading.
#[test]
fn no_delete_from_messages() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let infra_dir = Path::new(manifest_dir).join("src/infra");

    let rust_files = collect_rust_files(&infra_dir);
    if rust_files.is_empty() {
        return;
    }

    let forbidden = &["DELETE FROM messages", "DELETE FROM public.messages"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Skip comments
            if trimmed.starts_with("//") || trimmed.starts_with("*") {
                continue;
            }

            let upper = line.to_uppercase();
            for pattern in forbidden {
                if upper.contains(&pattern.to_uppercase()) {
                    violations.push(format!(
                        "  {}:{} - hard DELETE on messages table\n    > {}",
                        file.display(),
                        line_num + 1,
                        trimmed
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nData Safety Violation: Hard DELETE FROM messages found!\n\n\
            Messages must be soft-deleted (flagged with deleted_at), not hard-deleted.\n\
            Hard deletion loses audit trail and breaks message threading.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Use UPDATE messages SET deleted_at = NOW() instead of DELETE.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}
