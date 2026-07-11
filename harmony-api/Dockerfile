# syntax=docker/dockerfile:1.9

# -----------------------------------------------------------------------------
# Stage 0: NSFW model conversion (timm/safetensors -> ONNX)
# WHY: no first-party ONNX artifact exists for Marqo/nsfw-image-detection-384, so
# we convert the Apache-2.0 weights at build time and bundle the ~22MB ONNX file.
# This stage is BEST-EFFORT: on any failure (network, HF rate limit) it emits a
# 0-byte placeholder so the deploy never breaks — the Rust API validates the file
# at startup and falls back to the Noop classifier (adult images auto-approve;
# CSAM is a separate matcher and is unaffected). The heavy torch toolchain stays
# in this throwaway stage; only the ONNX file is copied into the runtime image.
# -----------------------------------------------------------------------------
FROM python:3.12-slim AS model-builder

WORKDIR /model
COPY scripts/export_nsfw_onnx.py .

RUN (pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
      && pip install --no-cache-dir "timm==1.0.*" onnx \
      && python export_nsfw_onnx.py /model/nsfw.onnx) \
    || (echo "NSFW ONNX export failed — emitting placeholder; API falls back to Noop" \
        && touch /model/nsfw.onnx)

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

# Bundle the NSFW ONNX model (see stage 0). Loaded once at startup when
# NSFW_CLASSIFIER_ENABLED=true + NSFW_MODEL_PATH points here; a placeholder/absent
# file degrades to the Noop classifier (logged at error level).
COPY --from=model-builder /model/nsfw.onnx /app/models/nsfw.onnx

USER nonroot:nonroot

EXPOSE 3000

ENTRYPOINT ["/app/harmony-api"]
