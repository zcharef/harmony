//! Exports the `OpenAPI` spec to stdout as JSON.
//!
//! Usage: `cargo run --bin export_openapi > openapi.json`
#![allow(clippy::expect_used, clippy::panic, clippy::print_stdout)]

use harmony_api::api::openapi::ApiDoc;
use utoipa::OpenApi;

fn main() {
    let spec = ApiDoc::openapi()
        .to_pretty_json()
        .expect("OpenAPI spec serialization must not fail");
    println!("{spec}");
}
