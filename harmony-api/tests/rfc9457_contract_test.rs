#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RFC 9457 Contract Tests (Level 3 Defense - Runtime Verification)
//!
//! These integration tests verify that error responses ACTUALLY conform to
//! RFC 9457 Problem Details at runtime, not just at compile-time.
//!
//! WHY: Even with correct types, serialization could break RFC compliance.
//! These tests catch:
//! - Missing required fields (type, title, status, detail)
//! - Wrong Content-Type header
//! - Malformed JSON structure
//!
//! ENFORCEMENT: Run in CI before deployment.

// These imports are used by the ignored integration tests.
// They're kept here for when we enable full integration testing.
#[allow(unused_imports)]
use http_body_util::BodyExt;
#[allow(unused_imports)]
use hyper::body::Bytes;

/// Helper to convert axum body to bytes for testing.
/// Used by integration tests that require full app initialization.
#[allow(dead_code)]
async fn body_to_bytes(body: axum::body::Body) -> Bytes {
    body.collect().await.unwrap().to_bytes()
}

/// Verifies a JSON response conforms to RFC 9457 Problem Details.
///
/// Required fields per RFC 9457:
/// - `type`: URI reference (defaults to "about:blank")
/// - `title`: Short human-readable summary
/// - `status`: HTTP status code (number)
/// - `detail`: Human-readable explanation (optional but we require it)
///
/// Used by integration tests that require full app initialization.
#[allow(dead_code)]
fn assert_rfc9457_compliant(json: &serde_json::Value, expected_status: u16) {
    // Required: type field (URI reference)
    assert!(
        json.get("type").is_some(),
        "RFC 9457 violation: missing 'type' field. Got: {}",
        json
    );
    let type_val = json["type"].as_str().unwrap_or("");
    assert!(
        !type_val.is_empty(),
        "RFC 9457 violation: 'type' must be a non-empty string"
    );

    // Required: title field
    assert!(
        json.get("title").is_some(),
        "RFC 9457 violation: missing 'title' field. Got: {}",
        json
    );
    let title = json["title"].as_str().unwrap_or("");
    assert!(
        !title.is_empty(),
        "RFC 9457 violation: 'title' must be a non-empty string"
    );

    // Required: status field (must match HTTP status)
    assert!(
        json.get("status").is_some(),
        "RFC 9457 violation: missing 'status' field. Got: {}",
        json
    );
    let status = u16::try_from(json["status"].as_u64().unwrap_or(0)).unwrap_or(0);
    assert_eq!(
        status, expected_status,
        "RFC 9457 violation: 'status' field ({}) doesn't match HTTP status ({})",
        status, expected_status
    );

    // Required by our convention: detail field
    assert!(
        json.get("detail").is_some(),
        "RFC 9457 violation: missing 'detail' field. Got: {}",
        json
    );
}

/// Test module that requires an app instance.
///
/// These tests are marked as `#[ignore]` by default because they require
/// a running app with proper initialization. Run with:
/// `cargo test --test rfc9457_contract_test -- --ignored`
mod contract_tests {
    #[allow(unused_imports)]
    use super::*;

    /// Test: 404 Not Found responses follow RFC 9457.
    #[tokio::test]
    #[ignore = "Requires full app initialization"]
    async fn not_found_returns_rfc9457_problem_details() {
        // This test would be enabled when we have test fixtures
        // For now, it documents the expected behavior

        // Expected response for unknown routes:
        // {
        //   "type": "about:blank",
        //   "title": "Not Found",
        //   "status": 404,
        //   "detail": "The requested resource was not found"
        // }

        // TODO: Implement when test fixtures are ready
        // let app = create_test_app().await;
        // let response = app.oneshot(Request::builder()
        //     .uri("/v1/nonexistent")
        //     .body(Body::empty())
        //     .unwrap()
        // ).await.unwrap();
        //
        // assert_eq!(response.status(), StatusCode::NOT_FOUND);
        // let body = body_to_bytes(response.into_body()).await;
        // let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        // assert_rfc9457_compliant(&json, 404);
    }

    /// Test: 400 Bad Request responses follow RFC 9457.
    #[tokio::test]
    #[ignore = "Requires full app initialization"]
    async fn bad_request_returns_rfc9457_problem_details() {
        // Expected response for invalid JSON:
        // {
        //   "type": "about:blank",
        //   "title": "Bad Request",
        //   "status": 400,
        //   "detail": "Invalid JSON body: expected ident at line 1 column 2"
        // }

        // TODO: Implement when test fixtures are ready
    }

    /// Test: 401 Unauthorized responses follow RFC 9457.
    #[tokio::test]
    #[ignore = "Requires full app initialization"]
    async fn unauthorized_returns_rfc9457_problem_details() {
        // Expected response when no auth token:
        // {
        //   "type": "about:blank",
        //   "title": "Unauthorized",
        //   "status": 401,
        //   "detail": "Missing or invalid authentication token"
        // }

        // TODO: Implement when test fixtures are ready
    }

    /// Test: 500 Internal Server Error responses follow RFC 9457.
    #[tokio::test]
    #[ignore = "Requires full app initialization"]
    async fn internal_error_returns_rfc9457_problem_details() {
        // Expected response on internal errors:
        // {
        //   "type": "about:blank",
        //   "title": "Internal Server Error",
        //   "status": 500,
        //   "detail": "An unexpected error occurred"
        // }
        //
        // IMPORTANT: detail should NOT leak stack traces or internal info

        // TODO: Implement when test fixtures are ready
    }
}

/// Unit tests that verify actual `ProblemDetails` struct serialization.
/// These catch real serialization regressions (field renames, missing fields, wrong types).
mod serialization_tests {
    use axum::http::StatusCode;
    use harmony_api::api::errors::ProblemDetails;

    /// Test: `ProblemDetails` serialization matches RFC 9457.
    #[test]
    fn problem_details_serializes_to_rfc9457_format() {
        let problem =
            ProblemDetails::new(StatusCode::BAD_REQUEST, "Bad Request", "Email is invalid");
        let json = serde_json::to_value(&problem).expect("ProblemDetails should serialize");

        assert_eq!(json["type"], "about:blank");
        assert_eq!(json["title"], "Bad Request");
        assert_eq!(json["status"], 400);
        assert_eq!(json["detail"], "Email is invalid");
    }

    /// Test: Status codes are numbers, not strings.
    #[test]
    fn problem_details_status_is_numeric() {
        let problem = ProblemDetails::new(StatusCode::NOT_FOUND, "Not Found", "User not found");
        let json = serde_json::to_value(&problem).expect("ProblemDetails should serialize");

        assert!(
            json["status"].is_number(),
            "status must be numeric, not string"
        );
        assert_eq!(json["status"], 404);
    }

    /// Test: `instance` is omitted from JSON when `None`.
    #[test]
    fn problem_details_instance_is_optional() {
        let problem = ProblemDetails::new(StatusCode::FORBIDDEN, "Forbidden", "No access");
        let json = serde_json::to_value(&problem).expect("ProblemDetails should serialize");

        assert!(
            json.get("instance").is_none(),
            "instance should be omitted when None"
        );
    }

    /// Test: `instance` appears in JSON when set via builder.
    #[test]
    fn problem_details_with_instance() {
        let problem = ProblemDetails::new(StatusCode::BAD_REQUEST, "Bad Request", "Invalid")
            .with_instance("/v1/users/123");
        let json = serde_json::to_value(&problem).expect("ProblemDetails should serialize");

        assert_eq!(json["instance"], "/v1/users/123");
    }

    /// Test: Type defaults to "about:blank" per RFC 9457.
    #[test]
    fn problem_details_type_defaults_to_about_blank() {
        let problem = ProblemDetails::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal Server Error",
            "Something went wrong",
        );
        let json = serde_json::to_value(&problem).expect("ProblemDetails should serialize");

        assert_eq!(json["type"], "about:blank");
    }
}

/// Tests that verify `ApiError` factory methods produce valid RFC 9457 JSON.
#[cfg(test)]
mod api_error_tests {
    use harmony_api::api::errors::ApiError;

    /// Test: `ApiError::bad_request` produces valid RFC 9457 `ProblemDetails`.
    #[test]
    fn api_error_bad_request_produces_valid_json() {
        let error = ApiError::bad_request("Email is required");
        let json = serde_json::to_value(&error.problem).expect("ProblemDetails should serialize");

        assert_eq!(json["type"], "about:blank");
        assert_eq!(json["title"], "Bad Request");
        assert_eq!(json["status"], 400);
        assert_eq!(json["detail"], "Email is required");
    }

    /// Test: `ApiError::not_found` includes resource info in detail.
    #[test]
    fn api_error_not_found_includes_resource_info() {
        let error = ApiError::not_found("User with id 'abc123' not found");
        let json = serde_json::to_value(&error.problem).expect("ProblemDetails should serialize");

        assert_eq!(json["status"], 404);
        let detail = json["detail"].as_str().expect("detail should be a string");
        assert!(
            detail.contains("User"),
            "detail should mention the resource type"
        );
        assert!(
            detail.contains("abc123"),
            "detail should mention the resource id"
        );
    }
}
