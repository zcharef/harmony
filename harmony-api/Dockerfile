# syntax=docker/dockerfile:1.9

# -----------------------------------------------------------------------------
# Stage 1: Builder
# -----------------------------------------------------------------------------
FROM rust:1.94-bookworm AS builder

WORKDIR /app

# Install mold linker for faster builds
RUN apt-get update && apt-get install -y --no-install-recommends \
    mold \
    clang \
    && rm -rf /var/lib/apt/lists/*

# Copy cargo config for mold linker
COPY .cargo .cargo

# Copy manifests first for dependency caching
COPY Cargo.toml Cargo.lock ./

# Create dummy main.rs to build dependencies (layer caching)
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies only (cached unless Cargo.toml changes)
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
# Stage 2: Runtime (Distroless)
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/cc-debian12:nonroot

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/harmony-api /app/harmony-api

# Run as non-root user (UID 65532 is 'nonroot' in distroless)
USER nonroot:nonroot

# Expose application port
EXPOSE 3000

# Health check endpoint
# Note: Distroless has no shell, health checks must be done via orchestrator
# Kubernetes liveness/readiness probes will use /health endpoint

ENTRYPOINT ["/app/harmony-api"]
