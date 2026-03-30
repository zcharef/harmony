#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RFC 9457 Contract Tests
//!
//! Unit tests verifying that `ProblemDetails` and `ApiError` structs serialize
//! to valid RFC 9457 Problem Details JSON. Catches serialization regressions
//! (field renames, missing fields, wrong types).

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
