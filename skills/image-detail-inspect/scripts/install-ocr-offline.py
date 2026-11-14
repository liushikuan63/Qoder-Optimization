#!/usr/bin/env python
"""install-ocr-offline.py - install OCR from a local bundle with ZERO network.

For intranet / shared environments where downloads are blocked. Uses
pip install --no-index --find-links <bundle>/wheels so only local wheels are
considered, then places the bundled models where rapidocr reads them locally.

All console output is ASCII.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys


def main():
    p = argparse.ArgumentParser(prog="install-ocr-offline.py")
    p.add_argument("--bundle", required=True)
    p.add_argument("--target", required=True, help="install dir (D drive)")
    p.add_argument("--py", default=sys.executable)
    p.add_argument("--check", action="store_true", help="import-test after install")
    args = p.parse_args()

    bundle = os.path.abspath(args.bundle)
    wheels = os.path.join(bundle, "wheels")
    models = os.path.join(bundle, "models")
    if not os.path.isdir(wheels) or not os.path.isdir(models):
        sys.stderr.write("ERROR: bundle missing wheels/ or models/: " + bundle + "\n")
        return 2
    target = os.path.abspath(args.target)
    os.makedirs(target, exist_ok=True)

    env = dict(os.environ)
    env["PIP_CACHE_DIR"] = os.path.join(bundle, ".pipcache-install")
    env["TMPDIR"] = bundle
    env["TEMP"] = bundle
    env["TMP"] = bundle
    cmd = [args.py, "-m", "pip", "install", "--no-cache-dir", "--no-index",
           "--find-links", wheels, "--target", target, "rapidocr", "onnxruntime"]
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write("ERROR: offline pip install failed exit=" + str(proc.returncode) + "\n" +
                         proc.stderr[-800:] + "\n")
        return 3

    dst_models = os.path.join(target, "rapidocr", "models")
    os.makedirs(dst_models, exist_ok=True)
    copied = []
    for f in sorted(os.listdir(models)):
        if f.endswith(".onnx"):
            shutil.copy2(os.path.join(models, f), os.path.join(dst_models, f))
            copied.append(f)
    if not copied:
        sys.stderr.write("ERROR: no models placed\n")
        return 4

    ok_import = None
    if args.check:
        code = ("import sys; sys.path.insert(0, r'" + target + "'); "
                "import rapidocr, onnxruntime; print('IMPORT_OK', rapidocr.__name__, onnxruntime.__version__)")
        cp = subprocess.run([args.py, "-c", code], env=env, capture_output=True, text=True)
        ok_import = cp.returncode == 0
        if not ok_import:
            sys.stderr.write("ERROR: import check failed: " + cp.stderr[-400:] + "\n")
            return 5

    print(json.dumps({"target": target, "models_placed": copied,
                      "no_index": True, "import_ok": ok_import}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())