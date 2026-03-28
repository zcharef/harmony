# syntax=docker/dockerfile:1.9

# -----------------------------------------------------------------------------
# Stage 1: Builder
# WHY multi-stage: final image is ~20MB (distroless) instead of ~1.5GB (rust).
# WHY SQLX_OFFLINE: compile-time query checking without a live database.
# The .sqlx/ directory (committed to repo) contains cached query metadata.
# Regenerate with: cargo sqlx prepare
# -----------------------------------------------------------------------------
FROM rust:1.94-bookworm AS builder

WORKDIR /app

# Copy manifests first for dependency caching
COPY Cargo.toml Cargo.lock ./

# Copy SQLx offline cache (compile-time query checking without live DB)
COPY .sqlx .sqlx

# Create dummy main.rs to build dependencies (layer caching)
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies only (cached unless Cargo.toml/Cargo.lock changes)
ENV SQLX_OFFLINE=true
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --bin harmony-api && rm -rf src

# Copy actual source code
COPY src src

# Touch main.rs to invalidate cache and rebuild with real code
RUN touch src/main.rs

# Build release binary
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --bin harmony-api && \
    cp /app/target/release/harmony-api /app/harmony-api

# -----------------------------------------------------------------------------
# Stage 2: Runtime (Distroless — ~20MB, no shell, no package manager)
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot

WORKDIR /app

COPY --from=builder /app/harmony-api /app/harmony-api

USER nonroot:nonroot

EXPOSE 3000

ENTRYPOINT ["/app/harmony-api"]
