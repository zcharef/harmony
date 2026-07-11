#!/usr/bin/env python3
"""Export the Marqo NSFW ViT classifier to ONNX for in-process `ort` inference.

The Rust API loads a binary NSFW ViT model via ONNX Runtime (see
`src/infra/onnx_nsfw_classifier.rs`). No first-party ONNX artifact is published
for `Marqo/nsfw-image-detection-384`, so we convert the timm/safetensors weights
to ONNX at Docker build time and bundle the result in the image.

Output: raw 2-class logits `[NSFW, SFW]` (softmax is applied in Rust). Input is a
normalized `NCHW` float tensor `[1, 3, 384, 384]`. The Rust preprocessing mirrors
the model card (`mean=std=0.5`, 384x384, bicubic-ish resize).

Usage: `python export_nsfw_onnx.py /out/nsfw.onnx`
"""

import sys

import timm
import torch

MODEL = "hf_hub:Marqo/nsfw-image-detection-384"
INPUT_SIZE = 384
OPSET = 17


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "nsfw.onnx"

    model = timm.create_model(MODEL, pretrained=True)
    model.eval()

    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)
    torch.onnx.export(
        model,
        dummy,
        out_path,
        input_names=["pixel_values"],
        output_names=["logits"],
        opset_version=OPSET,
        do_constant_folding=True,
        dynamic_axes=None,  # fixed 1x3x384x384 — matches the Rust preprocessing
    )
    print(f"exported ONNX model to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
