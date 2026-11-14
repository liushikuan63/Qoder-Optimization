#!/usr/bin/env python
"""build-ocr-offline-bundle.py - build an OFFLINE OCR bundle on a NETWORKED machine.

Downloads official PyPI wheels (current interpreter/platform) plus copies the
local RapidOCR models into one bundle dir, so an intranet machine can install
with --no-index (zero network). Run this where network IS available.

Sources are official only: PyPI (pip download) + already-local model files.
All console output is ASCII.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

DEFAULT_MODELS = os.path.join(os.environ.get("IMGDETAIL_OCR_LIB", os.path.join(os.path.expanduser("~"), ".qoder", "image-detail-libs")), "rapidocr", "models")
PKGS = ["rapidocr", "onnxruntime"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(prog="build-ocr-offline-bundle.py")
    p.add_argument("--out", required=True, help="bundle output dir")
    p.add_argument("--models-src", default=DEFAULT_MODELS)
    p.add_argument("--py", default=sys.executable)
    args = p.parse_args()

    out = os.path.abspath(args.out)
    wheels = os.path.join(out, "wheels")
    models = os.path.join(out, "models")
    os.makedirs(wheels, exist_ok=True)
    os.makedirs(models, exist_ok=True)

    env = dict(os.environ)
    env["PIP_CACHE_DIR"] = os.path.join(out, ".pipcache")
    env["TMPDIR"] = out
    env["TEMP"] = out
    env["TMP"] = out
    cmd = [args.py, "-m", "pip", "download", "--no-cache-dir", "--dest", wheels] + PKGS
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write("ERROR: pip download failed exit=" + str(proc.returncode) + "\n" +
                         proc.stderr[-800:] + "\n")
        return 2
    whl = [f for f in os.listdir(wheels) if f.endswith((".whl", ".tar.gz"))]
    if not whl:
        sys.stderr.write("ERROR: no wheels downloaded\n")
        return 3

    if not os.path.isdir(args.models_src):
        sys.stderr.write("ERROR: models src not found: " + args.models_src + "\n")
        return 4
    copied = []
    for f in sorted(os.listdir(args.models_src)):
        if f.endswith(".onnx"):
            shutil.copy2(os.path.join(args.models_src, f), os.path.join(models, f))
            copied.append(f)
    if not copied:
        sys.stderr.write("ERROR: no .onnx models copied\n")
        return 5

    manifest = {
        "packages": PKGS,
        "wheels": [{"name": f, "bytes": os.path.getsize(os.path.join(wheels, f)),
                    "sha256": sha256(os.path.join(wheels, f))} for f in sorted(whl)],
        "models": [{"name": f, "bytes": os.path.getsize(os.path.join(models, f)),
                    "sha256": sha256(os.path.join(models, f))} for f in copied],
        "python": sys.version.split()[0],
        "install": "install-ocr-offline.py --bundle <this dir> --target <dir>  (--no-index, zero network)",
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    total = sum(w["bytes"] for w in manifest["wheels"]) + sum(m["bytes"] for m in manifest["models"])
    print(json.dumps({"bundle": out, "wheels": len(whl), "models": len(copied),
                      "total_bytes": total, "manifest": os.path.join(out, "manifest.json")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())