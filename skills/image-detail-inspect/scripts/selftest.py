#!/usr/bin/env python
"""selftest.py - falsifiable self-test for imgdetail.py.

Automatable checks (R2 negative controls, R3 size budget, R4 coordinate
roundtrip) run here and exit non-zero on any failure.

The readability A/B (R1) is model-in-the-loop: this script only PREPARES the
three arms and writes the ground truth to expected.json. The operator must
Read the arm images FIRST, record which tokens are legible, and only THEN
compare against expected.json. Reading expected.json before the arms
contaminates the test.

Tokens are drawn from os.urandom so they cannot be derived from this source.
All console output is ASCII.
"""
import json
import os
import random
import string
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
IMGDETAIL = os.path.join(HERE, "imgdetail.py")
# Portable work dir; override with IMGDETAIL_SELFTEST_WORK to keep it off the system drive.
WORK = os.environ.get("IMGDETAIL_SELFTEST_WORK", os.path.join(tempfile.gettempdir(), "imgdetail-selftest"))


def _find_font():
    env = os.environ.get("IMGDETAIL_FONT")
    if env and os.path.isfile(env):
        return env
    for cand in (
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ):
        if os.path.isfile(cand):
            return cand
    return None


FONT = _find_font()
MAX_BYTES = int(1.5 * 1024 * 1024)

RESULTS = []


def record(name, ok, detail):
    RESULTS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + " :: " + detail)


def run(args, expect_zero=True):
    proc = subprocess.run([PY, IMGDETAIL] + args, capture_output=True, text=True)
    return proc


def token(n=9):
    alphabet = string.ascii_uppercase + string.digits
    rng = random.SystemRandom()
    raw = "".join(rng.choice(alphabet) for _ in range(n))
    return raw[:4] + "-" + raw[4:]


def build_fixture():
    os.makedirs(WORK, exist_ok=True)
    w, h = 2400, 1600
    im = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(im)
    regions = [
        ("r6", (100, 100, 620, 300), 6),
        ("r8", (700, 100, 1220, 300), 8),
        ("r10", (1300, 100, 1820, 300), 10),
        ("r14", (100, 700, 620, 900), 14),
        ("r24", (700, 700, 1220, 900), 24),
        # Blank region: anti-hallucination negative control. A reader that
        # invents text here is hallucinating, regardless of legibility elsewhere.
        ("r0", (100, 1100, 620, 1300), 0),
    ]
    expected = {"source_size": [w, h], "regions": [], "markers": []}
    for name, box, px in regions:
        tok = None
        if px > 0:
            tok = token()
            font = ImageFont.truetype(FONT, px) if FONT else ImageFont.load_default(size=px)
            d.text((box[0] + 10, box[1] + 40), tok, fill=(0, 0, 0), font=font)
        expected["regions"].append({"id": name, "font_px": px, "bbox": list(box), "token": tok})
    # fine detail: 1px lines, only survivable at native resolution
    for i in range(12):
        x = 1320 + i * 14
        d.line([(x, 720), (x, 880)], fill=(0, 0, 0), width=1)
    # roundtrip markers: single distinctive pixels at recorded source coords
    for mid, (mx, my) in enumerate([(1500, 800), (1514, 800), (1320, 720)]):
        im.putpixel((mx, my), (255, 0, 0))
        expected["markers"].append({"id": "m" + str(mid), "source": [mx, my]})
    path = os.path.join(WORK, "fixture.png")
    im.save(path, "PNG")
    with open(os.path.join(WORK, "expected.json"), "w", encoding="utf-8") as fh:
        json.dump(expected, fh, indent=2)
    return path, expected


def negative_controls(fixture):
    cases = [
        ("missing-source", ["probe", os.path.join(WORK, "does-not-exist.png")]),
        ("bbox-out-of-range", ["crop", fixture, "--bbox", "0,0,99999,99999", "--out", WORK]),
        ("bbox-reversed", ["crop", fixture, "--bbox", "500,500,100,100", "--out", WORK]),
        ("bbox-wrong-count", ["crop", fixture, "--bbox", "1,2,3", "--out", WORK]),
        ("grid-invalid", ["overview", fixture, "--grid", "99x99", "--out", WORK]),
        ("scale-zero", ["crop", fixture, "--bbox", "0,0,100,100", "--scale", "0", "--out", WORK]),
        ("map-point-outside", ["map", os.path.join(WORK, "arms", "crop_r6_x4.json"),
                               "--tile", "crop_r6_x4", "--point", "999999,999999"]),
    ]
    zero = os.path.join(WORK, "zero.png")
    with open(zero, "wb") as fh:
        fh.write(b"")
    cases.append(("zero-byte-source", ["probe", zero]))
    notimg = os.path.join(WORK, "notimage.png")
    with open(notimg, "wb") as fh:
        fh.write(b"this is not a png at all")
    cases.append(("undecodable-source", ["probe", notimg]))

    for name, args in cases:
        proc = run(args)
        ok = proc.returncode != 0 and "ERROR:" in (proc.stderr or "")
        lines = (proc.stderr or "").strip().splitlines()
        first = lines[0][:90] if lines else "no stderr"
        record("R2/" + name, ok, "exit=" + str(proc.returncode) + " stderr=" + first)
    # positive control: the same command shape on valid input must succeed
    proc = run(["crop", fixture, "--bbox", "100,100,620,300", "--scale", "4",
                "--name", "posctl", "--out", WORK])
    ok = proc.returncode == 0
    detail = "exit=" + str(proc.returncode)
    if ok:
        rec = json.loads(proc.stdout)
        ok = rec["size"] == [2080, 800] and rec["bytes"] <= MAX_BYTES
        detail += " size=" + str(rec["size"]) + " bytes=" + str(rec["bytes"])
    record("R2/positive-control", ok, detail)


def prepare_arms(fixture, expected):
    arms = os.path.join(WORK, "arms")
    os.makedirs(arms, exist_ok=True)
    made = []
    # arm A: the whole fixture, exactly as a naive Read would send it
    made.append({"arm": "A-full", "file": fixture, "note": "full 2400x1600 image"})
    for reg in expected["regions"]:
        bbox = ",".join(str(v) for v in reg["bbox"])
        for scale, tag in ((1.0, "native"), (4.0, "x4")):
            name = "crop_" + reg["id"] + "_" + tag
            proc = run(["crop", fixture, "--bbox", bbox, "--scale", str(scale),
                        "--name", name, "--out", arms])
            if proc.returncode != 0:
                record("R1/prepare-" + name, False, proc.stderr.strip()[:120])
                continue
            rec = json.loads(proc.stdout)
            made.append({"arm": "B-" + tag + "-" + reg["id"], "file": rec["file"],
                         "font_px": reg["font_px"], "scale": rec["scale"],
                         "bytes": rec["bytes"]})
    with open(os.path.join(WORK, "arms.json"), "w", encoding="utf-8") as fh:
        json.dump(made, fh, indent=2)
    record("R1/arms-prepared", len(made) == 13, "arms=" + str(len(made)) + " (expect 13)")
    return made


def size_budget(made):
    bad = [m for m in made if os.path.getsize(m["file"]) > MAX_BYTES]
    record("R3/all-arms-under-1.5MB", not bad,
           "checked=" + str(len(made)) + " over=" + str(len(bad)) +
           " max=" + str(max(os.path.getsize(m["file"]) for m in made)))


def coordinate_roundtrip(fixture, expected):
    # tile the fine-detail area, then map marker pixels back to source coords
    arms = os.path.join(WORK, "arms")
    proc = run(["crop", fixture, "--bbox", "1300,700,1700,900", "--scale", "3",
                "--name", "roundtrip", "--out", arms])
    if proc.returncode != 0:
        record("R4/roundtrip-crop", False, proc.stderr.strip()[:120])
        return
    rec = json.loads(proc.stdout)
    man = rec["manifest"]
    scale = rec["scale"]
    worst = 0.0
    measured = 0
    for mk in expected["markers"]:
        sx, sy = mk["source"]
        if not (1300 <= sx <= 1700 and 700 <= sy <= 900):
            continue
        tx, ty = (sx - 1300) * scale, (sy - 700) * scale
        p = run(["map", man, "--tile", "roundtrip", "--point", str(tx) + "," + str(ty)])
        if p.returncode != 0:
            record("R4/map-" + mk["id"], False, p.stderr.strip()[:120])
            continue
        out = json.loads(p.stdout)["source_point"]
        err = max(abs(out[0] - sx), abs(out[1] - sy))
        worst = max(worst, err)
        measured += 1
        record("R4/map-" + mk["id"], err <= 1.0,
               "source=" + str([sx, sy]) + " back=" + str(out) + " err=" + str(round(err, 4)))
    # A zero-measurement run must NOT report green: worst=0.0 with measured=0
    # means nothing was verified, which is exactly the false-green shape.
    record("R4/markers-measured>0", measured > 0, "measured=" + str(measured) + " of 3")
    record("R4/worst-error<=1px", measured > 0 and worst <= 1.0,
           "worst=" + str(round(worst, 4)) + " measured=" + str(measured))
    # negative control: a deliberately wrong scale must NOT roundtrip
    bad = run(["map", man, "--tile", "roundtrip", "--point", "0,0"])
    ok = bad.returncode == 0 and json.loads(bad.stdout)["source_point"] == [1300.0, 700.0]
    record("R4/origin-maps-to-bbox-origin", ok, bad.stdout.strip().replace("\n", " ")[:110])


def score_ab(readings_path):
    """Score the model-in-the-loop A/B readings against ground truth.

    R1 passes only if at least one region is NOT exact in the full-image arm
    but IS exact in the zoomed arm. A run where zoom changes nothing is RED.
    """
    with open(os.path.join(WORK, "expected.json"), "r", encoding="utf-8") as fh:
        expected = json.load(fh)
    with open(readings_path, "r", encoding="utf-8") as fh:
        readings = json.load(fh)["arms"]
    truth = {r["id"]: r["token"] for r in expected["regions"]}
    blank_markers = {"", "(blank)", "blank", "(empty)", "empty", None}
    wins = []
    rows = []
    for rid, tok in truth.items():
        if tok is None:
            # Anti-hallucination negative control: a blank region must be
            # reported blank. Inventing any token here is a hallucination.
            for arm in ("full", "native", "x4"):
                got = readings.get(arm, {}).get(rid)
                record("R9/blank-" + arm + "-" + rid, got in blank_markers,
                       "read=" + repr(got) + " (must be blank)")
            continue
        row = {"region": rid, "truth": tok}
        for arm in ("full", "native", "x4"):
            got = readings.get(arm, {}).get(rid)
            if got is None:
                row[arm] = None
                continue
            errs = sum(1 for a, b in zip(got, tok) if a != b) + abs(len(got) - len(tok))
            row[arm] = {"read": got, "exact": got == tok, "char_errors": errs}
        rows.append(row)
        f = row.get("full") or {}
        x = row.get("x4") or {}
        if f and x and not f.get("exact") and x.get("exact"):
            wins.append(rid)
    for row in rows:
        parts = []
        for arm in ("full", "native", "x4"):
            v = row.get(arm)
            parts.append(arm + "=" + ("-" if v is None else
                         ("EXACT" if v["exact"] else str(v["char_errors"]) + "err")))
        print("R1/region-" + row["region"] + " truth=" + row["truth"] + " " + " ".join(parts))
    record("R1/zoom-recovers-misread", len(wins) >= 1,
           "regions recovered by zoom=" + str(wins) + " (need >=1)")
    failed = [r for r in RESULTS if not r[1]]
    print("\nSUMMARY total=" + str(len(RESULTS)) + " pass=" + str(len(RESULTS) - len(failed)) +
          " fail=" + str(len(failed)))
    return 1 if failed else 0


def attribute_checks():
    """Non-text attributes (colour/saturation/contrast/texture/lighting).

    Positive control: two regions that genuinely differ must show a metric
    delta. Negative control: identical regions must show zero delta. A compare
    that always reports "same" (or always "different") is a false green.
    """
    a = Image.new("RGB", (200, 200), (120, 120, 120))
    b = Image.new("RGB", (200, 200), (200, 60, 60))
    d = ImageDraw.Draw(b)
    for i in range(0, 200, 8):
        d.line([(i, 0), (i, 200)], fill=(255, 255, 255), width=1)
    pa = os.path.join(WORK, "attr_a.png")
    pb = os.path.join(WORK, "attr_b.png")
    a.save(pa)
    b.save(pb)
    p = run(["compare", pa, pa, "--bbox", "0,0,200,200", "--scale", "2",
             "--name", "cmp_same", "--out", WORK])
    ok = p.returncode == 0
    detail = "exit=" + str(p.returncode)
    if ok:
        j = json.loads(p.stdout)
        ok = j["identical"] is True and j["diff_pixels"] == 0
        detail += " diff=" + str(j["diff_pixels"])
    record("R10/compare-identical-zero", ok, detail)
    p = run(["compare", pa, pb, "--bbox", "0,0,200,200", "--scale", "2",
             "--name", "cmp_diff", "--out", WORK])
    ok = p.returncode == 0
    detail = "exit=" + str(p.returncode)
    if ok:
        j = json.loads(p.stdout)
        dl = j["metric_delta"]
        ok = (j["diff_pixels"] > 0 and abs(dl["saturation_mean"]) > 10
              and abs(dl["texture_edge_energy"]) > 1 and abs(dl["contrast_rms"]) > 1)
        detail += (" diff=" + str(j["diff_pixels"]) + " dSat=" + str(dl["saturation_mean"]) +
                   " dTex=" + str(dl["texture_edge_energy"]) + " dCon=" + str(dl["contrast_rms"]))
    record("R10/compare-detects-attr-diff", ok, detail)
    sa = run(["stats", pa])
    sb = run(["stats", pb])
    ok = sa.returncode == 0 and sb.returncode == 0
    detail = "exit=" + str(sa.returncode) + "/" + str(sb.returncode)
    if ok:
        ma = json.loads(sa.stdout)["metrics"]
        mb = json.loads(sb.stdout)["metrics"]
        ok = mb["saturation_mean"] > ma["saturation_mean"] + 10 and \
            mb["texture_edge_energy"] > ma["texture_edge_energy"] + 1
        detail += (" satA=" + str(ma["saturation_mean"]) + " satB=" + str(mb["saturation_mean"]) +
                   " texA=" + str(ma["texture_edge_energy"]) + " texB=" + str(mb["texture_edge_energy"]))
    record("R10/stats-saturation-texture", ok, detail)


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(prog="selftest.py")
    p.add_argument("--ab-readings", default=None,
                   help="score recorded A/B readings instead of regenerating fixtures")
    args = p.parse_args(argv)
    if args.ab_readings:
        return score_ab(args.ab_readings)
    fixture, expected = build_fixture()
    print("fixture=" + fixture)
    print("ground truth written to " + os.path.join(WORK, "expected.json") +
          " (do NOT read it before the A/B arms)")
    # Arms first: the map-point-outside negative control needs a real manifest,
    # otherwise it would "pass" merely because the file is missing (false green).
    made = prepare_arms(fixture, expected)
    negative_controls(fixture)
    size_budget(made)
    coordinate_roundtrip(fixture, expected)
    attribute_checks()
    failed = [r for r in RESULTS if not r[1]]
    print("\nSUMMARY total=" + str(len(RESULTS)) + " pass=" + str(len(RESULTS) - len(failed)) +
          " fail=" + str(len(failed)))
    for name, _, detail in failed:
        print("  RED " + name + " :: " + detail)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())