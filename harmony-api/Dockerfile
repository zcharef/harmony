# syntax=docker/dockerfile:1.9

# -----------------------------------------------------------------------------
# Stage 0: NSFW model fetch (pre-converted ONNX, pinned by revision + sha256)
# WHY download, not convert: the previous build-time timm->ONNX conversion was
# fragile (torch/torchvision/timm op-registration mismatch — "operator
# torchvision::nms does not exist") and, on failure, silently emitted a 0-byte
# placeholder that degraded the classifier to Noop in prod. We instead pull a
# pre-converted ONNX export of Falconsai/nsfw_image_detection
# (onnx-community/nsfw_image_detection-ONNX, Apache-2.0) — no Python/torch/timm.
# The fetch is pinned to an IMMUTABLE commit AND checksum-verified, so the build
# is reproducible and fails LOUD if the artifact is missing or corrupt (never a
# silent placeholder; the Rust API keeps its own runtime Noop fallback as
# defense-in-depth). The ~87MB int8-quantized variant keeps f32 input/output
# (Rust tensor code unchanged) and fits the 512MB Fly machine. Only the .onnx is
# copied into the runtime image.
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS model-builder

# onnx-community/nsfw_image_detection-ONNX @ 1ceb3c7 -> onnx/model_quantized.onnx
ARG NSFW_MODEL_URL="https://huggingface.co/onnx-community/nsfw_image_detection-ONNX/resolve/1ceb3c7fe1e9f3f2507e6df577437f23a9149fd5/onnx/model_quantized.onnx"
ARG NSFW_MODEL_SHA256="d9afb1e057104e6cc8616d174f0f6a8b8b0389c839eea7d5efa4bdf1a77efd27"

WORKDIR /model
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fSL --retry 5 --retry-delay 2 --retry-all-errors \
        -o /model/nsfw.onnx "${NSFW_MODEL_URL}" \
    && echo "${NSFW_MODEL_SHA256}  /model/nsfw.onnx" | sha256sum -c -

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
# NSFW_CLASSIFIER_ENABLED=true + NSFW_MODEL_PATH points here; a missing/invalid
# file degrades to the Noop classifier (logged at error level).
COPY --from=model-builder /model/nsfw.onnx /app/models/nsfw.onnx

USER nonroot:nonroot

EXPOSE 3000

ENTRYPOINT ["/app/harmony-api"]
