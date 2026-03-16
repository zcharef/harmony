#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stdout)]
//! `OpenAPI` enforcement tests (static analysis).
//!
//! These tests verify that API handlers and DTOs follow the `OpenAPI` code-first
//! convention using utoipa macros. This prevents "undocumented endpoint" drift
//! where handlers are added without corresponding `OpenAPI` annotations.
//!
//! Rules enforced:
//! 1. Every public `async fn` in `src/api/handlers/` must have `#[utoipa::path]`
//! 2. Every struct in `src/api/dto/` must derive `ToSchema`
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

/// Test: Every handler function (pub async fn) must have a `#[utoipa::path]` annotation.
///
/// WHY: Without this annotation, the endpoint won't appear in the `OpenAPI` spec,
/// breaking the "code is the spec" contract. Clients won't know the endpoint exists.
///
/// Skips `mod.rs` re-export modules and the `not_found_fallback` (not a real endpoint).
#[test]
fn all_handler_functions_have_utoipa_path() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let handlers_dir = Path::new(manifest_dir).join("src/api/handlers");

    let rust_files = collect_rust_files(&handlers_dir);
    assert!(
        !rust_files.is_empty(),
        "No Rust files found in handlers directory"
    );

    let mut missing_annotations: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            // Look for public async handler functions
            if trimmed.starts_with("pub async fn ") {
                let fn_name = trimmed
                    .strip_prefix("pub async fn ")
                    .and_then(|rest| rest.split('(').next())
                    .unwrap_or("unknown");

                // Skip non-endpoint functions
                if fn_name == "not_found_fallback" {
                    continue;
                }

                // Check if any of the preceding 5 lines contain #[utoipa::path]
                let has_utoipa = (i.saturating_sub(10)..i)
                    .any(|j| lines.get(j).is_some_and(|l| l.contains("#[utoipa::path")));

                if !has_utoipa {
                    missing_annotations.push(format!(
                        "  {}:{} - `{}` missing #[utoipa::path] annotation",
                        file.display(),
                        i + 1,
                        fn_name
                    ));
                }
            }
        }
    }

    if !missing_annotations.is_empty() {
        panic!(
            "\n\nOpenAPI SSoT Violation: Handler functions without #[utoipa::path]!\n\n\
            Every public handler function must have a #[utoipa::path] annotation\n\
            so it appears in the OpenAPI spec (code-first contract).\n\n\
            Missing annotations ({}):\n{}\n\n\
            Fix: Add #[utoipa::path(get/post/..., path = \"...\", ...)] above each handler.\n",
            missing_annotations.len(),
            missing_annotations.join("\n")
        );
    }

    println!("OpenAPI enforcement passed: all handler functions have #[utoipa::path].");
}

/// Test: Every struct in DTOs must derive `ToSchema`.
///
/// WHY: DTO structs without `ToSchema` won't appear in the `OpenAPI` components,
/// making the generated TypeScript types incomplete.
///
/// Only checks files in `src/api/dto/` (not `mod.rs` re-export files).
#[test]
fn all_dto_structs_derive_to_schema() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dto_dir = Path::new(manifest_dir).join("src/api/dto");

    let rust_files: Vec<PathBuf> = collect_rust_files(&dto_dir)
        .into_iter()
        .filter(|f| f.file_name().is_some_and(|name| name != "mod.rs"))
        .collect();

    // If no DTO files exist yet (boilerplate state), this test passes trivially
    if rust_files.is_empty() {
        println!("OpenAPI enforcement passed: no DTO files to check (boilerplate state).");
        return;
    }

    let mut missing_derive: Vec<String> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        let lines: Vec<&str> = content.lines().collect();

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();

            // Look for struct definitions (pub struct Foo { or pub struct Foo;)
            if trimmed.starts_with("pub struct ") {
                let struct_name = trimmed
                    .strip_prefix("pub struct ")
                    .and_then(|rest| {
                        rest.split(|c: char| !c.is_alphanumeric() && c != '_')
                            .next()
                    })
                    .unwrap_or("unknown");

                // Check if any of the preceding 5 lines contain ToSchema
                let has_to_schema = (i.saturating_sub(5)..i)
                    .any(|j| lines.get(j).is_some_and(|l| l.contains("ToSchema")));

                if !has_to_schema {
                    missing_derive.push(format!(
                        "  {}:{} - `{}` missing #[derive(ToSchema)]",
                        file.display(),
                        i + 1,
                        struct_name
                    ));
                }
            }
        }
    }

    if !missing_derive.is_empty() {
        panic!(
            "\n\nOpenAPI SSoT Violation: DTO structs without ToSchema!\n\n\
            Every public struct in src/api/dto/ must derive `utoipa::ToSchema`\n\
            so it appears in the OpenAPI components section.\n\n\
            Missing derive ({}):\n{}\n\n\
            Fix: Add `#[derive(ToSchema)]` (from utoipa) to each DTO struct.\n",
            missing_derive.len(),
            missing_derive.join("\n")
        );
    }

    println!(
        "OpenAPI enforcement passed: all DTO structs in {} files derive ToSchema.",
        rust_files.len()
    );
}

/// Test: `OpenAPI` spec is valid and contains expected structure.
///
/// Verifies that the utoipa-generated `OpenAPI` spec can be serialized
/// and contains the minimum expected sections.
#[test]
fn openapi_spec_is_valid_and_complete() {
    use utoipa::OpenApi;

    let spec = harmony_api::api::openapi::ApiDoc::openapi();
    let json = spec
        .to_pretty_json()
        .expect("OpenAPI spec must serialize to JSON");

    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("OpenAPI JSON must be valid");

    // Verify required top-level fields
    assert!(
        parsed.get("openapi").is_some(),
        "OpenAPI spec must have 'openapi' version field"
    );
    assert!(
        parsed.get("info").is_some(),
        "OpenAPI spec must have 'info' section"
    );
    assert!(
        parsed.get("paths").is_some(),
        "OpenAPI spec must have 'paths' section"
    );

    // Verify /health endpoint is documented
    let paths = parsed.get("paths").unwrap();
    assert!(
        paths.get("/health").is_some(),
        "OpenAPI spec must include /health endpoint"
    );

    // Verify ProblemDetails schema exists in components
    let components = parsed
        .get("components")
        .expect("OpenAPI spec must have 'components' section");
    let schemas = components
        .get("schemas")
        .expect("Components must have 'schemas'");
    assert!(
        schemas.get("ProblemDetails").is_some(),
        "OpenAPI spec must include ProblemDetails schema (RFC 9457)"
    );

    println!("OpenAPI spec validation passed: structure is valid and complete.");
}
