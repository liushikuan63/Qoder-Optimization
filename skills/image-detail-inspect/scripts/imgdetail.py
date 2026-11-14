#!/usr/bin/env python
"""imgdetail.py - crop / zoom / tile an image so fine detail survives the vision pipeline.

Core mechanism (why this works): a large image gets downscaled before the model
sees it, so small text and small objects are destroyed. Cropping a region and
sending that region alone keeps it at native resolution. Upscaling is only
interpolation - it adds no information - but it makes small glyphs large enough
to read once the region is no longer being downscaled.

Zero third-party deps beyond Pillow. OCR is optional and isolated.
All console output is ASCII (Windows console may be GBK).

Interpreter: use your local Python that has Pillow installed (python / py). If the
python on PATH is a store stub or another profile, use its absolute path instead.
"""
import argparse
import json
import os
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageStat

# Matches huge-output-guard.js IMG_BYTES (1.5 MB). Read blocks images above this.
DEFAULT_MAX_BYTES = int(1.5 * 1024 * 1024)
JPEG_QUALITIES = (92, 85, 78, 70, 62)
# Portable defaults; override with IMGDETAIL_OUT / IMGDETAIL_OCR_LIB. To keep artifacts
# off the system drive, point IMGDETAIL_OUT at your preferred data disk.
DEFAULT_OUT = os.environ.get("IMGDETAIL_OUT", os.path.join(tempfile.gettempdir(), "imgdetail"))
OCR_LIB_DIR = os.environ.get("IMGDETAIL_OCR_LIB", os.path.join(os.path.expanduser("~"), ".qoder", "image-detail-libs"))
FONT_CANDIDATES = (
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
)


def die(msg, code=2):
    sys.stderr.write("ERROR: " + msg + "\n")
    sys.exit(code)


def load_source(path):
    if not path:
        die("source path is required")
    if not os.path.isfile(path):
        die("source not found: " + str(path))
    if os.path.getsize(path) == 0:
        die("source is zero bytes: " + str(path))
    try:
        im = Image.open(path)
        im.load()
    except Exception as exc:
        die("cannot decode image: " + str(path) + " (" + type(exc).__name__ + ")")
    return im


def parse_bbox(text, w, h):
    try:
        parts = [int(round(float(v))) for v in str(text).split(",")]
    except ValueError:
        die("bbox must be four numbers: x0,y0,x1,y1 (got " + str(text) + ")")
    if len(parts) != 4:
        die("bbox must have exactly 4 values, got " + str(len(parts)))
    x0, y0, x1, y1 = parts
    if x1 <= x0 or y1 <= y0:
        die("bbox must satisfy x1>x0 and y1>y0 (got " + str(parts) + ")")
    if x0 < 0 or y0 < 0 or x1 > w or y1 > h:
        die("bbox out of range: " + str(parts) + " not within 0,0," + str(w) + "," + str(h))
    return (x0, y0, x1, y1)


def parse_grid(text):
    try:
        cols, rows = str(text).lower().split("x")
        cols, rows = int(cols), int(rows)
    except ValueError:
        die("grid must look like 3x3 (got " + str(text) + ")")
    if not (1 <= cols <= 12 and 1 <= rows <= 12):
        die("grid cols/rows must be within 1..12")
    return cols, rows


def load_font(size):
    for cand in FONT_CANDIDATES:
        if os.path.isfile(cand):
            try:
                return ImageFont.truetype(cand, size)
            except Exception:
                continue
    return ImageFont.load_default()


def cell_id(col, row):
    letters = ""
    n = col
    while True:
        letters = chr(ord("A") + n % 26) + letters
        n = n // 26 - 1
        if n < 0:
            break
    return letters + str(row + 1)


def apply_enhance(im, mode):
    """Enhancement is a LEAD, not ground truth: sharpening invents edges."""
    if mode in ("contrast", "both"):
        im = ImageEnhance.Contrast(im).enhance(1.6)
    if mode in ("sharpen", "both"):
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=140, threshold=2))
    return im


def encode_within_budget(im, out_path, max_bytes):
    """Write im, shrinking/re-encoding until it fits max_bytes.

    Returns (final_path, bytes, format, shrink) where shrink is the extra
    downscale applied on top of the requested zoom. Callers must derive the
    effective scale from the ACTUAL output size, never from the request.
    """
    stem, _ = os.path.splitext(out_path)
    work = im
    shrink = 1.0
    for _ in range(7):
        png_path = stem + ".png"
        work.save(png_path, "PNG", optimize=True)
        size = os.path.getsize(png_path)
        if size <= max_bytes:
            return png_path, size, "PNG", shrink
        has_alpha = work.mode in ("RGBA", "LA", "PA")
        if not has_alpha:
            rgb = work.convert("RGB")
            for q in JPEG_QUALITIES:
                jpg_path = stem + ".jpg"
                rgb.save(jpg_path, "JPEG", quality=q, optimize=True)
                size = os.path.getsize(jpg_path)
                if size <= max_bytes:
                    if os.path.isfile(png_path):
                        os.remove(png_path)
                    return jpg_path, size, "JPEG", shrink
        w, h = work.size
        nw, nh = max(1, int(w * 0.85)), max(1, int(h * 0.85))
        if (nw, nh) == (w, h):
            break
        work = work.resize((nw, nh), Image.LANCZOS)
        shrink *= 0.85
    die("cannot fit image under " + str(max_bytes) + " bytes after shrinking; "
        "crop a smaller region instead", 3)


def ensure_out(path):
    d = os.path.abspath(path)
    os.makedirs(d, exist_ok=True)
    return d


def write_manifest(path, payload):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def cmd_probe(args):
    im = load_source(args.source)
    w, h = im.size
    nbytes = os.path.getsize(args.source)
    info = {
        "source": os.path.abspath(args.source),
        "size": [w, h],
        "mode": im.mode,
        "bytes": nbytes,
        "megapixels": round(w * h / 1e6, 3),
        "read_guard_would_block": nbytes > args.max_bytes,
        "read_guard_threshold": args.max_bytes,
    }
    print(json.dumps(info, indent=2))
    return 0


def cmd_overview(args):
    im = load_source(args.source)
    w, h = im.size
    cols, rows = parse_grid(args.grid)
    out_dir = ensure_out(args.out)
    long_edge = max(w, h)
    ratio = min(1.0, float(args.max_edge) / long_edge)
    ow, oh = max(1, int(w * ratio)), max(1, int(h * ratio))
    ov = im.convert("RGB").resize((ow, oh), Image.LANCZOS)
    draw = ImageDraw.Draw(ov)
    font = load_font(max(12, int(oh * 0.035)))
    tiles = []
    for r in range(rows):
        for c in range(cols):
            x0 = int(w * c / cols)
            x1 = int(w * (c + 1) / cols)
            y0 = int(h * r / rows)
            y1 = int(h * (r + 1) / rows)
            gx0, gx1 = int(ow * c / cols), int(ow * (c + 1) / cols)
            gy0, gy1 = int(oh * r / rows), int(oh * (r + 1) / rows)
            draw.rectangle([gx0, gy0, gx1 - 1, gy1 - 1], outline=(255, 0, 0), width=2)
            label = cell_id(c, r)
            draw.text((gx0 + 4, gy0 + 3), label, fill=(255, 0, 0), font=font)
            tiles.append({"id": label, "bbox": [x0, y0, x1, y1]})
    path, size, fmt, _ = encode_within_budget(ov, os.path.join(out_dir, "overview"), args.max_bytes)
    manifest = {
        "source": os.path.abspath(args.source),
        "source_size": [w, h],
        "grid": [cols, rows],
        "overview": path,
        "overview_size": [ow, oh],
        "overview_scale": round(ow / float(w), 6),
        "tiles": tiles,
    }
    mpath = os.path.join(out_dir, "overview.json")
    write_manifest(mpath, manifest)
    print(json.dumps({"overview": path, "bytes": size, "format": fmt,
                      "manifest": mpath, "cells": len(tiles)}, indent=2))
    return 0


def crop_one(im, bbox, scale, enhance, out_stem, max_bytes):
    region = im.crop(bbox)
    if scale != 1.0:
        nw = max(1, int(round(region.size[0] * scale)))
        nh = max(1, int(round(region.size[1] * scale)))
        region = region.resize((nw, nh), Image.LANCZOS)
    region = apply_enhance(region, enhance)
    path, size, fmt, shrink = encode_within_budget(region, out_stem, max_bytes)
    final = Image.open(path)
    fw, fh = final.size
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    return {
        "file": path,
        "bbox": list(bbox),
        "size": [fw, fh],
        "bytes": size,
        "format": fmt,
        "requested_scale": scale,
        "budget_shrink": round(shrink, 6),
        # Effective scale is measured from the real output, so coordinate
        # mapping stays correct even when the size budget forced a shrink.
        "scale": round(fw / float(bw), 6),
        "enhance": enhance,
    }


def cmd_crop(args):
    im = load_source(args.source)
    w, h = im.size
    bbox = parse_bbox(args.bbox, w, h)
    if args.scale <= 0:
        die("scale must be > 0")
    if args.scale > 12:
        die("scale > 12 is pure interpolation and wastes context; crop a tighter region")
    out_dir = ensure_out(args.out)
    stem = os.path.join(out_dir, args.name or "crop")
    rec = crop_one(im, bbox, args.scale, args.enhance, stem, args.max_bytes)
    rec["id"] = args.name or "crop"
    mpath = stem + ".json"
    write_manifest(mpath, {"source": os.path.abspath(args.source),
                           "source_size": [w, h], "tiles": [rec]})
    rec["manifest"] = mpath
    print(json.dumps(rec, indent=2))
    return 0


def cmd_tile(args):
    im = load_source(args.source)
    w, h = im.size
    cols, rows = parse_grid(args.grid)
    if not (0.0 <= args.overlap < 0.5):
        die("overlap must be within [0, 0.5)")
    out_dir = ensure_out(args.out)
    cw, ch = w / float(cols), h / float(rows)
    ox, oy = cw * args.overlap, ch * args.overlap
    tiles = []
    for r in range(rows):
        for c in range(cols):
            x0 = max(0, int(round(c * cw - ox)))
            y0 = max(0, int(round(r * ch - oy)))
            x1 = min(w, int(round((c + 1) * cw + ox)))
            y1 = min(h, int(round((r + 1) * ch + oy)))
            label = cell_id(c, r)
            rec = crop_one(im, (x0, y0, x1, y1), args.scale, args.enhance,
                           os.path.join(out_dir, "tile_" + label), args.max_bytes)
            rec["id"] = label
            tiles.append(rec)
    mpath = os.path.join(out_dir, "tiles.json")
    write_manifest(mpath, {"source": os.path.abspath(args.source),
                           "source_size": [w, h], "grid": [cols, rows],
                           "overlap": args.overlap, "tiles": tiles})
    over = [t["id"] for t in tiles if t["bytes"] > args.max_bytes]
    print(json.dumps({"manifest": mpath, "tiles": len(tiles),
                      "total_bytes": sum(t["bytes"] for t in tiles),
                      "over_budget": over}, indent=2))
    return 0 if not over else 4


def cmd_map(args):
    if not os.path.isfile(args.manifest):
        die("manifest not found: " + str(args.manifest))
    with open(args.manifest, "r", encoding="utf-8") as fh:
        man = json.load(fh)
    tile = None
    for t in man.get("tiles", []):
        base = os.path.basename(t.get("file", ""))
        stem = os.path.splitext(base)[0]
        if args.tile in (t.get("id"), base, stem):
            tile = t
            break
    if tile is None:
        die("tile not in manifest: " + str(args.tile))
    try:
        px, py = [float(v) for v in str(args.point).split(",")]
    except ValueError:
        die("point must be x,y in tile-local pixels")
    tw, th = tile["size"]
    if not (0 <= px <= tw and 0 <= py <= th):
        die("point outside tile: " + str(args.point) + " not within 0,0," + str(tw) + "," + str(th))
    scale = tile["scale"]
    if scale <= 0:
        die("manifest scale must be > 0")
    bx0, by0 = tile["bbox"][0], tile["bbox"][1]
    sx, sy = bx0 + px / scale, by0 + py / scale
    print(json.dumps({"tile": args.tile, "tile_point": [px, py],
                      "source_point": [round(sx, 3), round(sy, 3)],
                      "scale": scale, "bbox": tile["bbox"]}, indent=2))
    return 0


def region_metrics(im):
    """Quantitative, Pillow-only metrics for NON-text visual attributes.

    Grounds descriptions of texture / colour / saturation / contrast / lighting
    in measured numbers instead of adjectives, which is what reduces hallucination.
    """
    rgb = im.convert("RGB")
    st = ImageStat.Stat(rgb)
    hsv = rgb.convert("HSV")
    hs = ImageStat.Stat(hsv)
    lum = rgb.convert("L")
    ls = ImageStat.Stat(lum)
    edges = lum.filter(ImageFilter.FIND_EDGES)
    es = ImageStat.Stat(edges)
    hist = lum.histogram()
    total = sum(hist) or 1
    return {
        "rgb_mean": [round(v, 2) for v in st.mean],
        "rgb_std": [round(v, 2) for v in st.stddev],
        "hue_mean": round(hs.mean[0], 2),
        "saturation_mean": round(hs.mean[1], 2),
        "saturation_std": round(hs.stddev[1], 2),
        "luma_mean": round(ls.mean[0], 2),
        "contrast_rms": round(ls.stddev[0], 2),
        "texture_edge_energy": round(es.stddev[0], 2),
        "highlight_frac": round(sum(hist[240:]) / total, 4),
        "shadow_frac": round(sum(hist[:16]) / total, 4),
    }


SCALAR_METRICS = ("hue_mean", "saturation_mean", "saturation_std", "luma_mean",
                  "contrast_rms", "texture_edge_energy", "highlight_frac", "shadow_frac")


def cmd_stats(args):
    im = load_source(args.source)
    if args.bbox:
        im = im.crop(parse_bbox(args.bbox, im.size[0], im.size[1]))
    print(json.dumps({"source": os.path.abspath(args.source),
                      "bbox": args.bbox, "metrics": region_metrics(im)}, indent=2))
    return 0


def cmd_compare(args):
    """Local-sample zoom comparison for the FINAL visual check.

    Crops the SAME bbox from two images at the SAME scale and stacks them
    (A top, B bottom) so a reviewer can confirm the deliverable matches the
    intended effect region-by-region, instead of trusting a global thumbnail.
    """
    im_a = load_source(args.image_a)
    im_b = load_source(args.image_b)
    if im_a.size != im_b.size:
        die("compare requires same-size images: " + str(im_a.size) + " vs " + str(im_b.size))
    w, h = im_a.size
    bbox = parse_bbox(args.bbox, w, h)
    if args.scale <= 0 or args.scale > 12:
        die("scale must be within (0, 12]")
    out_dir = ensure_out(args.out)
    ca = im_a.crop(bbox)
    cb = im_b.crop(bbox)
    nw = max(1, int(round(ca.size[0] * args.scale)))
    nh = max(1, int(round(ca.size[1] * args.scale)))
    ca = ca.resize((nw, nh), Image.LANCZOS).convert("RGB")
    cb = cb.resize((nw, nh), Image.LANCZOS).convert("RGB")
    gap = 8
    canvas = Image.new("RGB", (nw, nh * 2 + gap), (255, 255, 255))
    canvas.paste(ca, (0, 0))
    canvas.paste(cb, (0, nh + gap))
    d = ImageDraw.Draw(canvas)
    font = load_font(max(14, int(nh * 0.06)))
    d.text((6, 4), "A", fill=(255, 0, 0), font=font)
    d.text((6, nh + gap + 4), "B", fill=(255, 0, 0), font=font)
    stem = os.path.join(out_dir, args.name or "pair")
    path, size, fmt, shrink = encode_within_budget(canvas, stem, args.max_bytes)
    # Pixel-level difference between the two halves: a compare that cannot
    # detect a real difference would be a false green, so expose the metric.
    # Diff the UNLABELED crops. The red A/B labels drawn on the canvas would
    # otherwise contaminate the metric (identical images must give diff=0).
    # ImageChops avoids the deprecated Image.getdata (removed in Pillow 14).
    diff_hist = ImageChops.difference(ca, cb).convert("L").histogram()
    diff = sum(diff_hist[1:])
    fa = Image.open(path).convert("RGB")
    fw, fh = fa.size
    half = (fh - gap) // 2
    ma = region_metrics(ca)
    mb = region_metrics(cb)
    delta = {k: round(mb[k] - ma[k], 3) for k in SCALAR_METRICS}
    rec = {"file": path, "bbox": list(bbox), "scale": args.scale,
           "bytes": size, "format": fmt, "half_size": [fw, half],
           "diff_pixels": diff, "identical": diff == 0,
           "metrics_a": ma, "metrics_b": mb, "metric_delta": delta}
    mpath = stem + ".json"
    write_manifest(mpath, {"image_a": os.path.abspath(args.image_a),
                           "image_b": os.path.abspath(args.image_b), "pair": rec})
    rec["manifest"] = mpath
    print(json.dumps(rec, indent=2))
    return 0


def cmd_ocr(args):
    # Allow an isolated/offline install dir to be tested without touching the
    # real lib (R11). Default stays the shared D-drive lib.
    lib_dir = os.environ.get("IMGDETAIL_OCR_LIB", OCR_LIB_DIR)
    if os.path.isdir(lib_dir) and lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    try:
        from rapidocr import RapidOCR
    except Exception as exc:
        die("OCR backend unavailable (" + type(exc).__name__ + ": " + str(exc) + "). "
            "Install into " + lib_dir + " (offline: install-ocr-offline) or fall back to "
            "model-vision crop+zoom reading, which needs no OCR. "
            "Core crop/zoom commands do not need OCR.", 5)
    im = load_source(args.source)
    off_x, off_y = 0, 0
    if args.bbox:
        box = parse_bbox(args.bbox, im.size[0], im.size[1])
        off_x, off_y = box[0], box[1]
        im = im.crop(box)
    engine = RapidOCR()
    result = engine(_to_array(im))
    # Observed API (rapidocr 3.10): RapidOCROutput with .boxes/.txts/.scores.
    # These may be numpy arrays: never use `or []` (array truth value is ambiguous).
    boxes = getattr(result, "boxes", None)
    txts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    boxes = [] if boxes is None else list(boxes)
    txts = [] if txts is None else list(txts)
    scores = [] if scores is None else list(scores)
    items = []
    for box, text, score in zip(boxes, txts, scores):
        items.append({
            "text": text,
            "score": round(float(score), 4),
            # Report SOURCE coordinates so every OCR string is grounded to a place.
            "box_source": [[round(float(p[0]) + off_x, 1), round(float(p[1]) + off_y, 1)]
                           for p in box],
        })
    print(json.dumps({"source": os.path.abspath(args.source),
                      "bbox_offset": [off_x, off_y],
                      "count": len(items), "items": items}, ensure_ascii=False, indent=2))
    return 0


def _to_array(im):
    import numpy as np
    return np.array(im.convert("RGB"))


def build_parser():
    p = argparse.ArgumentParser(prog="imgdetail.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES,
                   help="per-file output budget (default 1572864 = Read guard threshold)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("probe", help="report size/mode/bytes and Read-guard verdict")
    s.add_argument("source")
    s.set_defaults(fn=cmd_probe)

    s = sub.add_parser("overview", help="downscaled grid overview to locate regions")
    s.add_argument("source")
    s.add_argument("--grid", default="3x3")
    s.add_argument("--max-edge", type=int, default=1000)
    s.add_argument("--out", default=DEFAULT_OUT)
    s.set_defaults(fn=cmd_overview)

    s = sub.add_parser("crop", help="crop one bbox and zoom it")
    s.add_argument("source")
    s.add_argument("--bbox", required=True, help="x0,y0,x1,y1 in SOURCE pixels")
    s.add_argument("--scale", type=float, default=1.0)
    s.add_argument("--enhance", choices=("none", "contrast", "sharpen", "both"), default="none")
    s.add_argument("--name", default=None)
    s.add_argument("--out", default=DEFAULT_OUT)
    s.set_defaults(fn=cmd_crop)

    s = sub.add_parser("tile", help="cut the whole image into readable grid tiles")
    s.add_argument("source")
    s.add_argument("--grid", default="3x3")
    s.add_argument("--scale", type=float, default=1.0)
    s.add_argument("--overlap", type=float, default=0.08)
    s.add_argument("--enhance", choices=("none", "contrast", "sharpen", "both"), default="none")
    s.add_argument("--out", default=DEFAULT_OUT)
    s.set_defaults(fn=cmd_tile)

    s = sub.add_parser("map", help="map a tile-local point back to SOURCE pixels")
    s.add_argument("manifest")
    s.add_argument("--tile", required=True)
    s.add_argument("--point", required=True, help="x,y in tile-local pixels")
    s.set_defaults(fn=cmd_map)

    s = sub.add_parser("stats", help="quantitative region metrics: texture/colour/saturation/contrast/lighting")
    s.add_argument("source")
    s.add_argument("--bbox", default=None, help="x0,y0,x1,y1 in SOURCE pixels; omit for whole image")
    s.set_defaults(fn=cmd_stats)

    s = sub.add_parser("compare", help="same-bbox same-scale zoom pair (A top/B bottom) for final visual check")
    s.add_argument("image_a")
    s.add_argument("image_b")
    s.add_argument("--bbox", required=True, help="x0,y0,x1,y1 in SOURCE pixels")
    s.add_argument("--scale", type=float, default=3.0)
    s.add_argument("--name", default=None)
    s.add_argument("--out", default=DEFAULT_OUT)
    s.set_defaults(fn=cmd_compare)

    s = sub.add_parser("ocr", help="optional OCR; needs rapidocr (set IMGDETAIL_OCR_LIB to its lib dir)")
    s.add_argument("source")
    s.add_argument("--bbox", default=None)
    s.set_defaults(fn=cmd_ocr)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.max_bytes <= 0:
        die("--max-bytes must be > 0")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())