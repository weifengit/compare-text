#!/usr/bin/env python3
"""Generate app icon for compare-text: rounded squircle, two diff cards.

Usage:
    pip install pillow
    python3 tools/gen_icon.py [output.png]   # default: /tmp/icon-new.png
    npx tauri icon <output.png>              # regenerate all icon sizes
"""
import sys
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # supersample factor
S = 1024
W = S * SS

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# --- Background: rounded squircle with diagonal gradient ---
R = int(W * 0.225)  # corner radius

# vertical-ish diagonal gradient: deep indigo -> violet
c0 = (58, 64, 158)    # top-left
c1 = (124, 82, 189)   # bottom-right
grad = Image.new("RGB", (W, W))
gd = ImageDraw.Draw(grad)
for y in range(W):
    for_row_t = y / W
    gd.line([(0, y), (W, y)], fill=(
        int(c0[0] + (c1[0] - c0[0]) * for_row_t),
        int(c0[1] + (c1[1] - c0[1]) * for_row_t),
        int(c0[2] + (c1[2] - c0[2]) * for_row_t),
    ))
# soften with a radial highlight at top-left
highlight = Image.new("L", (W, W), 0)
hd = ImageDraw.Draw(highlight)
hd.ellipse([-W*0.5, -W*0.55, W*0.75, W*0.55], fill=70)
highlight = highlight.filter(ImageFilter.GaussianBlur(W * 0.12))
white_layer = Image.new("RGB", (W, W), (255, 255, 255))
grad = Image.composite(white_layer, grad, highlight)

mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, W - 1, W - 1], radius=R, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)

# --- Two document cards ---
card_fill = (248, 249, 252, 255)
line_gray = (176, 183, 201, 255)
red = (239, 83, 80, 255)
green = (52, 199, 123, 255)

def card(cx, cy, w, h, rot, lines, hl_idx, hl_color):
    """Draw a card with text lines on its own layer, rotate, paste with shadow."""
    pad = int(w * 0.16)
    lw = int(h * 0.055)  # line thickness
    gap = (h - 2 * pad - lw) / (len(lines) - 1) if len(lines) > 1 else 0
    layer = Image.new("RGBA", (int(w * 1.6), int(h * 1.3)), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ox = (layer.width - w) // 2
    oy = (layer.height - h) // 2
    ld.rounded_rectangle([ox, oy, ox + w, oy + h], radius=int(w * 0.10), fill=card_fill)
    for i, frac in enumerate(lines):
        y = oy + pad + i * gap
        x0 = ox + pad
        x1 = ox + pad + (w - 2 * pad) * frac
        col = hl_color if i == hl_idx else line_gray
        ld.rounded_rectangle([x0, y - lw / 2, x1, y + lw / 2], radius=lw / 2, fill=col)
    if rot:
        layer = layer.rotate(rot, resample=Image.BICUBIC, expand=False)
    # shadow
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    alpha = layer.split()[3].point(lambda a: a * 0.35)
    black = Image.new("RGBA", layer.size, (20, 20, 60, 255))
    black.putalpha(alpha)
    sh.paste(black, (int(cx - layer.width / 2), int(cy - layer.height / 2 + W * 0.018)), black)
    sh = sh.filter(ImageFilter.GaussianBlur(W * 0.012))
    img.alpha_composite(sh)
    img.alpha_composite(layer, (int(cx - layer.width / 2), int(cy - layer.height / 2)))

cw = int(W * 0.285)
ch = int(W * 0.52)

# left card (red diff)
card(W * 0.335, W * 0.50, cw, ch, rot=-3,
     lines=[0.85, 0.7, 0.8, 0.65, 0.78], hl_idx=2, hl_color=red)
# right card (green diff)
card(W * 0.665, W * 0.50, cw, ch, rot=3,
     lines=[0.8, 0.68, 0.85, 0.72, 0.66], hl_idx=2, hl_color=green)

# --- Downscale ---
out = img.resize((S, S), Image.LANCZOS)
out_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/icon-new.png"
out.save(out_path)
print(f"saved {out_path}")
