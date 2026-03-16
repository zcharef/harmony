#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stdout)]
//! Architecture tests for hexagonal boundary enforcement.
//!
//! These tests verify that the domain layer remains pure (no infra/api dependencies)
//! and that the API layer uses ports (traits) instead of concrete implementations.
//!
//! Rules enforced:
//! 1. `src/domain/` MUST NOT import from `crate::infra` or `crate::api`
//! 2. `src/api/handlers/` SHOULD use `dyn Trait` from ports, not concrete types
//!
//! Approach: Static analysis via regex on source files (no external dependencies).

use std::fs;
use std::path::{Path, PathBuf};

/// Patterns that indicate forbidden imports in domain layer.
const FORBIDDEN_DOMAIN_IMPORTS: &[&str] = &[
    "crate::infra",
    "crate::api",
    "super::super::infra",
    "super::super::api",
];

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

/// Extracts use statements and direct module references from Rust source code.
/// Returns a list of (`line_number`, `line_content`) for lines containing imports.
fn extract_import_lines(content: &str) -> Vec<(usize, String)> {
    content
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let trimmed = line.trim();
            trimmed.starts_with("use ")
                || trimmed.contains("crate::")
                || trimmed.contains("super::")
        })
        .map(|(num, line)| (num + 1, line.to_string()))
        .collect()
}

/// Checks if a line contains any of the forbidden patterns.
fn contains_forbidden_import(line: &str, forbidden: &[&str]) -> Option<String> {
    for pattern in forbidden {
        if line.contains(pattern) {
            return Some((*pattern).to_string());
        }
    }
    None
}

#[derive(Debug)]
struct Violation {
    file: PathBuf,
    line_number: usize,
    line_content: String,
    pattern: String,
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "  {}:{} - forbidden import '{}'\n    > {}",
            self.file.display(),
            self.line_number,
            self.pattern,
            self.line_content.trim()
        )
    }
}

/// Test: Domain layer must not depend on infra or api.
///
/// The domain layer should be pure Rust with no infrastructure dependencies.
/// This ensures business logic can be tested in isolation and infrastructure
/// can be swapped without touching domain code.
#[test]
fn domain_does_not_depend_on_infra_or_api() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let domain_dir = Path::new(manifest_dir).join("src/domain");

    let rust_files = collect_rust_files(&domain_dir);
    assert!(
        !rust_files.is_empty(),
        "No Rust files found in domain directory: {}",
        domain_dir.display()
    );

    let mut violations: Vec<Violation> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_number, line) in extract_import_lines(&content) {
            if let Some(pattern) = contains_forbidden_import(&line, FORBIDDEN_DOMAIN_IMPORTS) {
                violations.push(Violation {
                    file: file.clone(),
                    line_number,
                    line_content: line,
                    pattern,
                });
            }
        }
    }

    if !violations.is_empty() {
        let messages: Vec<String> = violations
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        panic!(
            "\n\nHexagonal Architecture Violation: Domain layer depends on infra/api!\n\n\
            The domain layer must be pure and not import from infrastructure or API layers.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Move infrastructure-dependent code to src/infra/ and use ports (traits) in domain.\n",
            violations.len(),
            messages.join("\n")
        );
    }

    println!(
        "Architecture check passed: {} domain files verified, no forbidden imports found.",
        rust_files.len()
    );
}

/// Test: API handlers should use trait objects (ports), not concrete implementations.
///
/// Handlers should depend on `dyn Trait`, not concrete types like `PostgresXxxRepository`.
/// This is verified by checking that handler files don't directly import concrete
/// repository implementations from infra.
#[test]
fn api_handlers_use_ports_not_concrete_types() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let handlers_dir = Path::new(manifest_dir).join("src/api/handlers");

    let rust_files = collect_rust_files(&handlers_dir);
    assert!(
        !rust_files.is_empty(),
        "No Rust files found in handlers directory: {}",
        handlers_dir.display()
    );

    // Concrete types that should NOT be imported in handlers.
    // Add future concrete implementations here as they are created.
    let forbidden_concrete_imports: &[&str] = &[
        "PostgresUserRepository",
        "PostgresServerRepository",
        "PostgresChannelRepository",
        "PostgresMessageRepository",
    ];

    let mut violations: Vec<Violation> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_number, line) in content.lines().enumerate() {
            let line_num = line_number + 1;
            for concrete_type in forbidden_concrete_imports {
                if line.contains(concrete_type) {
                    violations.push(Violation {
                        file: file.clone(),
                        line_number: line_num,
                        line_content: line.to_string(),
                        pattern: (*concrete_type).to_string(),
                    });
                }
            }
        }
    }

    if !violations.is_empty() {
        let messages: Vec<String> = violations
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        panic!(
            "\n\nHexagonal Architecture Violation: API handlers import concrete implementations!\n\n\
            Handlers should use trait objects from ports (e.g., `Arc<dyn UserRepository>`),\n\
            not concrete types (e.g., `PostgresUserRepository`).\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Access repositories through AppState which uses `Arc<dyn Trait>` pattern.\n",
            violations.len(),
            messages.join("\n")
        );
    }

    println!(
        "Architecture check passed: {} handler files verified, no concrete type imports found.",
        rust_files.len()
    );
}

/// Test: Main.rs should wire dependencies correctly.
///
/// Verifies that main.rs creates concrete implementations and wires them
/// through `AppState`, not leaking concrete types elsewhere.
#[test]
fn main_wires_dependencies_at_composition_root() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let main_file = Path::new(manifest_dir).join("src/main.rs");

    let content = fs::read_to_string(&main_file)
        .unwrap_or_else(|e| panic!("Failed to read {}: {}", main_file.display(), e));

    assert!(
        content.contains("AppState"),
        "\n\nArchitecture Check: main.rs should create AppState (composition root).\n\n\
        The main function is the composition root where concrete implementations\n\
        are instantiated and wired together via AppState.\n"
    );

    println!("Architecture check passed: main.rs acts as composition root.");
}

/// Test: Source code must not contain `#[automock]` or `#[derive(Mock)]`.
///
/// ADR-018: No mock testing strategy. Tests use real infrastructure
/// (testcontainers, wiremock) instead of mock frameworks like mockall.
#[test]
fn no_automock_attribute_in_source() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_dir = Path::new(manifest_dir).join("src");

    let rust_files = collect_rust_files(&src_dir);
    assert!(
        !rust_files.is_empty(),
        "No Rust files found in src directory: {}",
        src_dir.display()
    );

    let forbidden_mock_patterns: &[&str] = &["#[automock]", "#[derive(Mock)]"];

    let mut violations: Vec<Violation> = Vec::new();

    for file in &rust_files {
        let content = fs::read_to_string(file).unwrap_or_else(|e| {
            panic!("Failed to read {}: {}", file.display(), e);
        });

        for (line_number, line) in content.lines().enumerate() {
            let line_num = line_number + 1;
            for pattern in forbidden_mock_patterns {
                if line.contains(pattern) {
                    violations.push(Violation {
                        file: file.clone(),
                        line_number: line_num,
                        line_content: line.to_string(),
                        pattern: (*pattern).to_string(),
                    });
                }
            }
        }
    }

    if !violations.is_empty() {
        let messages: Vec<String> = violations
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        panic!(
            "\n\nADR-018 Violation: Mock attributes are forbidden!\n\n\
            Use real infrastructure (testcontainers) instead of mock frameworks.\n\
            External HTTP services should use wiremock.\n\n\
            Violations found ({}):\n{}\n\n\
            Fix: Remove mock attributes and use real implementations in tests.\n",
            violations.len(),
            messages.join("\n")
        );
    }

    println!(
        "Architecture check passed: {} source files verified, no mock attributes found.",
        rust_files.len()
    );
}

#[cfg(test)]
mod architecture_summary {
    //! Summary of hexagonal architecture rules enforced by these tests.
    //!
    //! ```text
    //! ┌─────────────────────────────────────────────────────────────┐
    //! │                      HEXAGONAL ARCHITECTURE                 │
    //! ├─────────────────────────────────────────────────────────────┤
    //! │                                                             │
    //! │   ┌─────────────┐                                           │
    //! │   │   main.rs   │  ← Composition Root (wires concrete)      │
    //! │   └──────┬──────┘                                           │
    //! │          │                                                  │
    //! │          ▼                                                  │
    //! │   ┌─────────────┐     ┌─────────────┐                       │
    //! │   │  API Layer  │────▶│  AppState   │                       │
    //! │   │ (handlers)  │     │ (Arc<dyn T>)│                       │
    //! │   └──────┬──────┘     └──────┬──────┘                       │
    //! │          │                   │                              │
    //! │          │      ┌────────────┘                              │
    //! │          │      │                                           │
    //! │          ▼      ▼                                           │
    //! │   ┌─────────────────────┐                                   │
    //! │   │    DOMAIN LAYER     │  ← PURE (no infra deps)           │
    //! │   │  models / ports /   │                                   │
    //! │   │      services       │                                   │
    //! │   └──────────┬──────────┘                                   │
    //! │              │                                              │
    //! │              │ (traits)                                     │
    //! │              ▼                                              │
    //! │   ┌─────────────────────┐                                   │
    //! │   │   INFRA LAYER       │  ← Implements traits              │
    //! │   │ postgres / auth /   │                                   │
    //! │   │      etc            │                                   │
    //! │   └─────────────────────┘                                   │
    //! │                                                             │
    //! └─────────────────────────────────────────────────────────────┘
    //! ```
    //!
    //! **Key Rules:**
    //! 1. Domain NEVER imports from infra or api
    //! 2. API uses ports (traits) via `AppState`, not concrete types
    //! 3. Infra implements domain ports
    //! 4. main.rs is the only place concrete types are wired
}
