#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! API convention enforcement tests (static analysis).
//!
//! These tests scan source files for API-level anti-patterns that would pass
//! compilation but violate project conventions for REST API design.
//!
//! Rules enforced:
//! 1. All routes must be versioned (`/v1/...`) except system endpoints
//! 2. Handlers must not construct response DTOs inline
//! 3. No WebSocket/SSE imports (Supabase Realtime handles push)
//! 4. All handlers must have `#[tracing::instrument]`
//! 5. No OFFSET-based pagination in SQL (use cursor-based)
//! 6. No page/offset fields in DTOs
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

/// Test: All routes must be versioned.
///
/// WHY: API versioning (`/v1/...`) is mandatory for backward compatibility.
/// System endpoints (`/health`, `/swagger-ui`, `/api-docs`) are exempt.
#[test]
fn all_routes_versioned() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let router_file = Path::new(manifest_dir).join("src/api/router.rs");

    let content = fs::read_to_string(&router_file)
        .unwrap_or_else(|e| panic!("Failed to read {}: {}", router_file.display(), e));

    let exempt_prefixes = &["/health", "/swagger", "/api-docs"];

    let mut violations: Vec<String> = Vec::new();

    for (line_num, line) in content.lines().enumerate() {
        let trimmed = line.trim();

        // Skip comments
        if trimmed.starts_with("//") || trimmed.starts_with("*") {
            continue;
        }

        // Look for .route(" patterns
        if let Some(route_start) = trimmed.find(".route(\"") {
            let after_route = &trimmed[route_start + 8..]; // skip `.route("`
            if let Some(end_quote) = after_route.find('"') {
                let path = &after_route[..end_quote];

                // Check if exempt
                let is_exempt = exempt_prefixes
                    .iter()
                    .any(|prefix| path.starts_with(prefix));

                // Check if versioned
                let is_versioned = path.starts_with("/v");

                if !is_exempt && !is_versioned {
                    violations.push(format!(
                        "  {}:{} - unversioned route '{}'\n    > {}",
                        router_file.display(),
                        line_num + 1,
                        path,
                        trimmed
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nAPI Versioning Violation: Unversioned routes found!\n\n\
            All API routes must be versioned (e.g., /v1/users, /v1/servers).\n\
            System endpoints (/health, /swagger-ui, /api-docs) are exempt.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Prefix routes with /v1/ (or nest under Router::new().nest(\"/v1\", ...)).\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test b) ────────────────────────────────────────────────────────────────

/// Test: Handlers must not construct response DTOs inline.
///
/// WHY: Response DTOs should be constructed via `From<DomainModel>` impls,
/// not inline in handlers. Inline construction couples handlers to DTO
/// internals and makes refactoring error-prone.
#[test]
fn handlers_dont_construct_dtos_inline() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let handlers_dir = Path::new(manifest_dir).join("src/api/handlers");

    let rust_files = collect_rust_files(&handlers_dir);
    assert!(
        !rust_files.is_empty(),
        "No Rust files found in handlers directory"
    );

    // Pattern: structs ending in "Response" being constructed inline
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

            // Skip test code
            if trimmed.contains("#[cfg(test)]") || trimmed.contains("#[test]") {
                continue;
            }

            // Look for inline DTO construction: `SomethingResponse {`
            // but not struct definitions (pub struct), imports (use), or trait bounds (IntoResponse)
            if trimmed.contains("Response {")
                && !trimmed.starts_with("pub struct ")
                && !trimmed.starts_with("struct ")
                && !trimmed.starts_with("use ")
                && !trimmed.starts_with("///")
                // Exclude trait bounds and return types (IntoResponse, impl Response)
                && !trimmed.contains("IntoResponse")
                && !trimmed.contains("impl Response")
            {
                // Allow system endpoint DTOs — not domain models
                if trimmed.contains("HealthResponse")
                    || trimmed.contains("ComponentHealth")
                    || trimmed.contains("LivenessResponse")
                {
                    continue;
                }

                violations.push(format!(
                    "  {}:{} - inline Response DTO construction in handler\n    > {}",
                    file.display(),
                    line_num + 1,
                    trimmed
                ));
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nHandler Convention Violation: Inline DTO construction in handlers!\n\n\
            Response DTOs should be constructed via From<DomainModel> impls:\n\
            - impl From<User> for UserResponse {{ ... }}\n\
            - let response: UserResponse = user.into();\n\n\
            Inline construction couples handlers to DTO internals.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Create a From<DomainModel> impl for the response DTO and use .into().\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test c) ────────────────────────────────────────────────────────────────

/// Test: No WebSocket or SSE imports.
///
/// WHY: Supabase Realtime handles all push notifications. The API has NO
/// SSE/WebSocket endpoints. Writes go through REST; Supabase pushes changes
/// to clients automatically.
#[test]
fn no_websocket_or_sse_imports() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(!rust_files.is_empty(), "No Rust files found in src/");

    let forbidden = &[
        "axum::extract::ws",
        "axum::response::sse",
        "tokio_tungstenite",
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

            for pattern in forbidden {
                if line.contains(pattern) {
                    violations.push(format!(
                        "  {}:{} - forbidden realtime import '{}'\n    > {}",
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
            "\n\nArchitecture Violation: WebSocket/SSE imports found!\n\n\
            Supabase Realtime handles all push notifications.\n\
            The API must NOT have SSE or WebSocket endpoints.\n\
            Writes go through REST; Supabase pushes changes to clients automatically.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Remove WebSocket/SSE code. Use Supabase Realtime for push notifications.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test d) ────────────────────────────────────────────────────────────────

/// Test: All handler functions must have `#[tracing::instrument]`.
///
/// WHY: Every handler must be instrumented for observability. Without it,
/// distributed traces have gaps and debugging production issues is impossible.
///
/// Skips: `health_check` (high-frequency, low-value tracing) and
/// `not_found_fallback` (not a real business handler).
#[test]
fn all_handlers_have_tracing_instrument() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let handlers_dir = Path::new(manifest_dir).join("src/api/handlers");

    let rust_files = collect_rust_files(&handlers_dir);
    assert!(
        !rust_files.is_empty(),
        "No Rust files found in handlers directory"
    );

    let skip_functions = &["health_check", "not_found_fallback"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            if trimmed.starts_with("pub async fn ") {
                let fn_name = trimmed
                    .strip_prefix("pub async fn ")
                    .and_then(|rest| rest.split('(').next())
                    .unwrap_or("unknown");

                // Skip exempt functions
                if skip_functions.contains(&fn_name) {
                    continue;
                }

                // Check if any of the preceding 10 lines contain #[tracing::instrument]
                let has_instrument = (i.saturating_sub(10)..i).any(|j| {
                    lines
                        .get(j)
                        .is_some_and(|l| l.contains("tracing::instrument"))
                });

                if !has_instrument {
                    violations.push(format!(
                        "  {}:{} - `{}` missing #[tracing::instrument]",
                        file.display(),
                        i + 1,
                        fn_name
                    ));
                }
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nObservability Violation: Handler functions without #[tracing::instrument]!\n\n\
            Every handler function must be instrumented for distributed tracing.\n\
            Without instrumentation, production debugging is impossible.\n\n\
            Missing instrumentation ({}):\n{}\n\n\
            Fix: Add #[tracing::instrument(skip(state))] above each handler function.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test e) ────────────────────────────────────────────────────────────────

/// Test: No OFFSET in SQL queries.
///
/// WHY: OFFSET-based pagination is O(n) — the database scans and discards rows.
/// Use cursor-based pagination (WHERE id > $1 ORDER BY id LIMIT $2) instead.
#[test]
fn no_offset_in_sql() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let infra_dir = Path::new(manifest_dir).join("src/infra");

    let rust_files = collect_rust_files(&infra_dir);
    if rust_files.is_empty() {
        return;
    }

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

            // Look for OFFSET in SQL strings (case-insensitive, word boundary)
            let upper = line.to_uppercase();
            if upper.contains(" OFFSET ") {
                violations.push(format!(
                    "  {}:{} - OFFSET-based pagination in SQL\n    > {}",
                    file.display(),
                    line_num + 1,
                    trimmed
                ));
            }
        }
    }

    if !violations.is_empty() {
        panic!(
            "\n\nPagination Violation: OFFSET-based pagination found in SQL!\n\n\
            OFFSET-based pagination is O(n) — the database scans and discards rows.\n\
            Use cursor-based pagination instead:\n\
            WHERE id > $1 ORDER BY id LIMIT $2\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace OFFSET with cursor-based pagination using WHERE id > cursor.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}

// ─── Test f) ────────────────────────────────────────────────────────────────

/// Test: No page/offset fields in DTOs.
///
/// WHY: Pagination fields like `page`, `page_number`, `offset` indicate
/// OFFSET-based pagination, which is O(n). DTOs should use cursor-based
/// pagination fields (`cursor`, `after`, `before`) instead.
#[test]
fn no_page_params_in_dtos() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dto_dir = Path::new(manifest_dir).join("src/api/dto");

    let rust_files: Vec<PathBuf> = collect_rust_files(&dto_dir)
        .into_iter()
        .filter(|f| f.file_name().is_some_and(|name| name != "mod.rs"))
        .collect();

    if rust_files.is_empty() {
        return;
    }

    let forbidden_fields = &["pub page:", "pub page_number:", "pub offset:"];

    let mut violations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_num, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            for field in forbidden_fields {
                if trimmed.contains(field) {
                    violations.push(format!(
                        "  {}:{} - OFFSET-style pagination field in DTO\n    > {}",
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
            "\n\nPagination Violation: OFFSET-style pagination fields in DTOs!\n\n\
            Fields like page, page_number, offset indicate OFFSET-based pagination.\n\
            Use cursor-based pagination fields (cursor, after, before) instead.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Replace page/offset fields with cursor-based pagination.\n",
            violations.len(),
            violations.join("\n")
        );
    }
}
