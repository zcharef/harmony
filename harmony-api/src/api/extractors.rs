//! Custom extractors for RFC 9457 compliant error responses.

use std::ops::Deref;

use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, Path, Request},
    http::request::Parts,
};
use serde::de::DeserializeOwned;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::domain::models::UserId;
use crate::infra::auth::AuthenticatedUser;

/// Custom JSON extractor that returns RFC 9457 `ProblemDetails` on parse failure.
///
/// Drop-in replacement for `axum::Json<T>` in handler parameters.
#[derive(Debug)]
pub struct ApiJson<T>(pub T);

impl<T> Deref for ApiJson<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    #[allow(clippy::manual_async_fn)]
    fn from_request(
        req: Request,
        state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            match Json::<T>::from_request(req, state).await {
                Ok(Json(value)) => Ok(ApiJson(value)),
                Err(rejection) => {
                    // WHY: Preserve Axum's status code semantics (400 syntax, 422 data, 415 content-type)
                    // while wrapping the body text in RFC 9457 ProblemDetails.
                    let status = rejection.status();
                    Err(ApiError {
                        status,
                        problem: ProblemDetails::new(
                            status,
                            status.canonical_reason().unwrap_or_default(),
                            rejection.body_text(),
                        ),
                    })
                }
            }
        }
    }
}

/// Custom path extractor that returns RFC 9457 `ProblemDetails` on parse failure.
///
/// Drop-in replacement for `axum::extract::Path<T>` in handler parameters.
#[derive(Debug)]
pub struct ApiPath<T>(pub T);

impl<T> Deref for ApiPath<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    #[allow(clippy::manual_async_fn)]
    fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            match Path::<T>::from_request_parts(parts, state).await {
                Ok(Path(value)) => Ok(ApiPath(value)),
                Err(rejection) => {
                    // WHY: Map Axum's plain-text path errors to RFC 9457 ProblemDetails.
                    Err(ApiError::bad_request(rejection.body_text()))
                }
            }
        }
    }
}

/// Extractor that pulls the authenticated user's ID from request extensions.
///
/// Requires the `require_auth` middleware to have run first, which inserts
/// `AuthenticatedUser` into extensions after JWT/session verification.
///
/// Usage in handlers: `AuthUser(user_id): AuthUser`
#[derive(Debug)]
pub struct AuthUser(pub UserId);

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    #[allow(clippy::manual_async_fn)]
    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            // WHY: AuthenticatedUser is inserted by the auth middleware layer.
            // If missing, the request bypassed auth — reject immediately.
            let user = parts
                .extensions
                .get::<AuthenticatedUser>()
                .ok_or_else(|| ApiError::unauthorized("Authentication required"))?;

            Ok(AuthUser(user.user_id.clone()))
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use axum::http::{StatusCode, header};

    #[tokio::test]
    async fn test_api_json_rejection_returns_problem_details_400() {
        use axum::body::Body;

        let request = http::Request::builder()
            .method("POST")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("not valid json"))
            .unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct Dummy {
            #[allow(dead_code)]
            field: String,
        }

        let result = ApiJson::<Dummy>::from_request(request, &()).await;
        assert!(result.is_err());

        let api_error = result.unwrap_err();
        assert_eq!(api_error.status, StatusCode::BAD_REQUEST);
        assert_eq!(api_error.problem.status, 400);
        assert_eq!(api_error.problem.title, "Bad Request");
        assert!(!api_error.problem.detail.is_empty());
    }
}
