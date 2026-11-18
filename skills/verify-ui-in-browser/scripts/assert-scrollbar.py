"""滚动条视觉语言像素断言（可失败）。

用法:
  python assert-scrollbar.py <screenshot.png> [--thumb #4a7ac0] [--track #0b1c3a]
         [--width 8] [--forbid #3460a5,#0f234b] [--y 400] [--min-contrast 3]

判据（任一不满足即 EXIT 1）:
  1. 截图右缘 30px 内、指定 y 行上 thumb 色连续带宽 == --width（默认 8px）
  2. 该列自顶向下不得出现 --forbid 列出的反例色（旧/反相调色板）
  3. 该列必须出现 track 色（证明暗轨真实渲染，而非透明/默认轨）
  4. thumb 与 track 的 WCAG 对比度 >= --min-contrast（默认 3:1，非文本控件）

默认值来自 暗色主题 2026-11-18 实测（8px #4a7ac0 / 轨 #0b1c3a / 3.90:1）；
换项目时显式传 --thumb/--track/--forbid，不要沿用默认调色板。
负对照：对注入旧配色的截图跑本脚本必须 EXIT 1，否则断言无效（假绿）。
依赖: Pillow（库路径由运行环境提供，见技能正文）。
"""
import argparse
import sys
from PIL import Image


def hexrgb(s):
    s = s.lstrip('#')
    if len(s) != 6:
        raise argparse.ArgumentTypeError('color must be #rrggbb: %s' % s)
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def lum(c):
    def f(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in c)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--thumb', type=hexrgb, default=(74, 122, 192))
    ap.add_argument('--track', type=hexrgb, default=(11, 28, 58))
    ap.add_argument('--width', type=int, default=8)
    ap.add_argument('--forbid', type=lambda s: [hexrgb(x) for x in s.split(',') if x], default=[])
    ap.add_argument('--y', type=int, default=400)
    ap.add_argument('--min-contrast', type=float, default=3.0)
    a = ap.parse_args()

    im = Image.open(a.image).convert('RGB')
    w, h = im.size
    y = min(max(a.y, 0), h - 1)
    fails = []

    band = [x for x in range(max(0, w - 30), w) if im.getpixel((x, y)) == a.thumb]
    if len(band) != a.width:
        fails.append('thumb band width %d != %d at y%d: %s' % (len(band), a.width, y, band))

    col = band[0] if band else w - 25
    seen = {}
    for yy in range(60, h - 8):
        c = im.getpixel((col, yy))
        seen[c] = seen.get(c, 0) + 1
        if c in a.forbid:
            fails.append('forbidden palette pixel at y%d: %s' % (yy, c))
            break
    if not any(c == a.track for c in seen):
        fails.append('no track pixels in column; seen=%s' % seen)

    ratio = (lum(a.thumb) + 0.05) / (lum(a.track) + 0.05)
    if ratio < a.min_contrast:
        fails.append('contrast %.2f < %.2f' % (ratio, a.min_contrast))

    print('column x=%d colors=%s' % (col, seen))
    print('contrast thumb/track = %.2f' % ratio)
    if fails:
        print('FAIL: ' + '; '.join(fails))
        sys.exit(1)
    print('PASS: %dpx thumb on track, no forbidden palette, contrast %.2f:1' % (a.width, ratio))


if __name__ == '__main__':
    main()