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

/// Tests pinning the plan-gate error contract: the `FEATURE_NOT_IN_PLAN` /
/// `PLAN_LIMIT_REACHED` split and the structured `plan_gate` extension the
/// client paywall consumes.
#[cfg(test)]
mod plan_gate_tests {
    use harmony_api::api::errors::ApiError;
    use harmony_api::domain::errors::DomainError;
    use harmony_api::domain::models::{Plan, ResourceKind};

    fn to_json(err: DomainError) -> serde_json::Value {
        let api_error = ApiError::from_domain(err);
        serde_json::to_value(&api_error.problem).expect("ProblemDetails should serialize")
    }

    /// Test: a ZERO limit means the feature is not in the plan at all —
    /// code `FEATURE_NOT_IN_PLAN`, not "limit reached" phrasing.
    #[test]
    fn zero_limit_maps_to_feature_not_in_plan() {
        let json = to_json(DomainError::LimitExceeded {
            resource: ResourceKind::CustomEmoji,
            plan: Some(Plan::Free),
            limit: 0,
        });

        assert_eq!(json["status"], 403);
        assert_eq!(json["code"], "FEATURE_NOT_IN_PLAN");
        assert_eq!(json["title"], "Feature Not In Plan");
        let detail = json["detail"].as_str().expect("detail");
        assert!(
            !detail.contains("reached"),
            "zero-limit copy must not claim a limit was 'reached': {detail}"
        );
        assert!(detail.contains("custom emoji"));
        assert!(detail.contains("free"));

        assert_eq!(json["plan_gate"]["resource"], "custom_emoji");
        assert_eq!(json["plan_gate"]["current_plan"], "free");
        assert_eq!(json["plan_gate"]["limit"], 0);
        // Supporter is the lowest tier with custom emoji (100).
        assert_eq!(json["plan_gate"]["required_plan"], "supporter");
        assert!(
            json["upgrade_url"]
                .as_str()
                .expect("url")
                .contains("pricing")
        );
    }

    /// Test: a NONZERO limit keeps the limit-reached semantics and copy
    /// (the e2e suite asserts plan/limit/resource appear in `detail`).
    #[test]
    fn nonzero_limit_maps_to_plan_limit_reached() {
        let json = to_json(DomainError::LimitExceeded {
            resource: ResourceKind::OwnedServers,
            plan: Some(Plan::Free),
            limit: 3,
        });

        assert_eq!(json["status"], 403);
        assert_eq!(json["code"], "PLAN_LIMIT_REACHED");
        assert_eq!(json["title"], "Plan Limit Exceeded");
        let detail = json["detail"].as_str().expect("detail");
        assert!(detail.contains("free"));
        assert!(detail.contains('3'));
        assert!(detail.contains("owned servers"));

        assert_eq!(json["plan_gate"]["resource"], "owned_servers");
        assert_eq!(json["plan_gate"]["current_plan"], "free");
        assert_eq!(json["plan_gate"]["limit"], 3);
        assert_eq!(json["plan_gate"]["required_plan"], "supporter");
    }

    /// Test: at the top tier's ceiling there is nothing to recommend —
    /// `required_plan` is omitted, not null.
    #[test]
    fn top_tier_ceiling_omits_required_plan() {
        let json = to_json(DomainError::LimitExceeded {
            resource: ResourceKind::OwnedServers,
            plan: Some(Plan::Creator),
            limit: 25,
        });

        assert_eq!(json["code"], "PLAN_LIMIT_REACHED");
        assert!(
            json["plan_gate"].get("required_plan").is_none(),
            "required_plan should be omitted at the Creator ceiling"
        );
    }

    /// Test: without a tier (self-hosted enforcement paths) there is no
    /// upsell — no `code`, no `plan_gate`, generic 403 message.
    #[test]
    fn no_plan_maps_to_generic_limit_error() {
        let json = to_json(DomainError::LimitExceeded {
            resource: ResourceKind::VoiceConcurrent,
            plan: None,
            limit: 10_000,
        });

        assert_eq!(json["status"], 403);
        assert_eq!(json["title"], "Plan Limit Exceeded");
        assert!(json.get("code").is_none(), "no code without a tier");
        assert!(
            json.get("plan_gate").is_none(),
            "no plan_gate without a tier"
        );
    }
}
