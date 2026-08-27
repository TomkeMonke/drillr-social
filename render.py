"""
Slide renderer for the TikTok photo-carousel pipeline.

    python render.py <spec.json>
    python render.py --font-sample     # candidate-font contact sheet

Reads a post spec (built by slideshow.mjs, never hand-written) and writes one
PNG per slide into the spec's outDir. Pure composition: it draws the text you
give it over the background you give it and nothing else.

WHY PILLOW AND NOT NODE
-----------------------
The look is one specific thing - heavy white type with a thick black outline,
auto-fitted to the frame - and Pillow's ImageDraw does stroked text natively
(`stroke_width` / `stroke_fill`). The Node options all cost more: sharp has no
text layout at all, node-canvas needs a native toolchain that does not build
cleanly on this machine, and satori/resvg means shipping an SVG renderer to
draw six words. screenshots/retouch.py already established Pillow here, so the
dependency is paid for.

HOW THE TEXT IS SIZED
---------------------
Never by a fixed point size. The same template carries "Lock in" and "5. You
always play it safe because you're scared", and a fixed size either clips the
long one or leaves the short one looking timid. So each slide binary-searches
the largest size at which the greedy-wrapped text still fits both the text box
AND the line budget. That is what keeps every slide in a carousel looking like
it came from the same template even though the copy lengths vary 4x.

The outline width scales WITH the font size (STROKE_RATIO), not as a constant.
A constant stroke reads as a hairline on the hook slide and as a blob on the
CTA slide.

Requires Pillow (`pip install Pillow`).
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

DIR = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(DIR, "fonts")

# ---- template constants ----
# Derived by measuring the reference carousel (7656186846942203169). Ratios, not
# pixels, so a future 1440x2560 render keeps the same proportions.
CANVAS = (1080, 1920)
TEXT_WIDTH_PCT = 0.88     # text box width as a fraction of canvas width
LINE_SPACING = 1.18       # line advance as a multiple of font size
STROKE_RATIO = 0.070      # outline width as a multiple of font size
MAX_LINES = 4             # past 4 lines the slide stops being skimmable
MIN_FONT = 28
MAX_FONT = 200

# Vertical placement of the text block's CENTRE, per layout. `center` sits just
# above the true middle because the eye reads a centred block as low when the
# subject's face is in the upper third - which it is in every football wallpaper.
LAYOUT_CENTRE = {
    "center": 0.47,
    "top": 0.22,
    "bottom": 0.74,
}
# Height budget for the text block, per layout. `top` gets less because the CTA
# slide has to leave the bottom two thirds for the app screenshot.
LAYOUT_HEIGHT_PCT = {
    "center": 0.46,
    "top": 0.34,
    "bottom": 0.34,
}


def load_font(name, size):
    path = name if os.path.isabs(name) else os.path.join(FONTS, name)
    if not path.lower().endswith((".ttf", ".otf")):
        path += ".ttf"
    if not os.path.exists(path):
        raise SystemExit(
            "font not found: %s\n"
            "Run `node slideshow.mjs fonts` to fetch the candidates."
            % path
        )
    return ImageFont.truetype(path, size)


def wrap(text, font, max_width, draw):
    """Greedy word wrap. Returns None if any single word overflows on its own."""
    words = text.split()
    if not words:
        return []
    lines, line = [], words[0]
    for word in words[1:]:
        probe = line + " " + word
        if draw.textlength(probe, font=font) <= max_width:
            line = probe
        else:
            lines.append(line)
            line = word
    lines.append(line)
    for candidate in lines:
        if draw.textlength(candidate, font=font) > max_width:
            return None  # an unbreakable word; caller shrinks and retries
    return lines


def fit_text(draw, text, font_name, box_w, box_h, max_lines=MAX_LINES):
    """Largest font size whose wrapped text fits the box and the line budget."""
    best = None
    lo, hi = MIN_FONT, MAX_FONT
    while lo <= hi:
        mid = (lo + hi) // 2
        font = load_font(font_name, mid)
        lines = wrap(text, font, box_w, draw)
        block_h = len(lines) * mid * LINE_SPACING if lines else box_h + 1
        if lines is not None and len(lines) <= max_lines and block_h <= box_h:
            best = (mid, lines, font)
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        # Copy too long for the budget. Render at the floor rather than crash:
        # a cramped slide is reviewable, a stack trace at 3am is not.
        font = load_font(font_name, MIN_FONT)
        return MIN_FONT, wrap(text, font, box_w, draw) or [text], font
    return best


def cover(img, size):
    """Scale-and-centre-crop so the image fills `size` with no letterboxing."""
    target_w, target_h = size
    scale = max(target_w / img.width, target_h / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
        Image.LANCZOS,
    )
    left = (resized.width - target_w) // 2
    top = (resized.height - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def rounded(img, radius_pct):
    """Round an overlay's corners. Phone screenshots pasted square read as a bug."""
    if radius_pct <= 0:
        return img
    img = img.convert("RGBA")
    radius = round(min(img.width, img.height) * radius_pct)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, img.width - 1, img.height - 1), radius=radius, fill=255
    )
    img.putalpha(mask)
    return img


def draw_slide(slide, spec):
    width, height = spec.get("width", CANVAS[0]), spec.get("height", CANVAS[1])
    font_name = spec.get("font", "Nunito.ttf")

    bg_path = slide.get("background")
    if bg_path and os.path.exists(bg_path):
        canvas = cover(Image.open(bg_path).convert("RGB"), (width, height))
    else:
        canvas = Image.new("RGB", (width, height), (17, 17, 20))

    # Optional global dim. Off by default - the outline carries legibility on
    # every reference slide - but a blown-out white kit background needs it.
    dim = float(slide.get("dim", spec.get("dim", 0)))
    if dim > 0:
        shade = Image.new("RGB", (width, height), (0, 0, 0))
        canvas = Image.blend(canvas, shade, min(1.0, dim))

    canvas = canvas.convert("RGBA")

    # Overlays go UNDER the text: on the CTA slide the app screenshot is the
    # subject and the copy sits above it, never on top of it.
    for over in slide.get("overlays", []):
        path = over.get("path")
        if not path or not os.path.exists(path):
            print("  ! overlay missing, skipped: %s" % path)
            continue
        layer = Image.open(path).convert("RGBA")
        target_w = round(width * float(over.get("widthPct", 0.5)))
        scale = target_w / layer.width
        layer = layer.resize(
            (target_w, max(1, round(layer.height * scale))), Image.LANCZOS
        )
        layer = rounded(layer, float(over.get("radiusPct", 0)))
        x = round(width * float(over.get("xPct", 0.5)) - layer.width / 2)
        y = round(height * float(over.get("yPct", 0.5)) - layer.height / 2)
        canvas.alpha_composite(layer, (x, y))

    draw = ImageDraw.Draw(canvas)
    text = (slide.get("text") or "").strip()
    if text:
        layout = slide.get("layout", "center")
        box_w = round(width * TEXT_WIDTH_PCT)
        box_h = round(height * LAYOUT_HEIGHT_PCT.get(layout, 0.46))
        max_lines = int(slide.get("maxLines", MAX_LINES))
        size, lines, font = fit_text(draw, text, font_name, box_w, box_h, max_lines)

        stroke = max(1, round(size * STROKE_RATIO))
        advance = size * LINE_SPACING
        block_h = len(lines) * advance
        centre_y = height * LAYOUT_CENTRE.get(layout, 0.47)
        y = centre_y - block_h / 2 + advance / 2

        for line in lines:
            draw.text(
                (width / 2, y),
                line,
                font=font,
                fill=slide.get("color", "#FFFFFF"),
                anchor="mm",
                stroke_width=stroke,
                stroke_fill=slide.get("strokeColor", "#000000"),
            )
            y += advance

    return canvas.convert("RGB")


def render_spec(spec_path):
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)

    out_dir = spec["outDir"]
    os.makedirs(out_dir, exist_ok=True)

    written = []
    for index, slide in enumerate(spec["slides"], start=1):
        image = draw_slide(slide, spec)
        # Zero-padded so the carousel uploads in order on every filesystem.
        out = os.path.join(out_dir, "%02d.jpg" % index)
        # JPEG, not PNG: TikTok pulls these over the wire and a photo background
        # gains nothing from lossless. quality=92 is visually clean at ~350 KB.
        image.save(out, "JPEG", quality=92, optimize=True, progressive=True)
        written.append(out)
        preview = (slide.get("text") or "")[:52]
        print("  %02d.jpg  %s" % (index, preview))

    return written


def font_sample():
    """Contact sheet of the candidate fonts on one reference line.

    The reference carousel's font is TikTok's own built-in, which is not
    redistributable, so this picks the closest Google Font by eye. Run it, look
    at the output, and set `font` in config.json.
    """
    line = "5 things that will kill your football career"
    candidates = [f for f in sorted(os.listdir(FONTS)) if f.endswith(".ttf")]
    if not candidates:
        raise SystemExit("no fonts in %s - run `slideshow.mjs fonts` first" % FONTS)

    cell = 300
    sheet = Image.new("RGB", (1080, cell * len(candidates)), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    for i, name in enumerate(candidates):
        top = i * cell
        size, lines, font = fit_text(draw, line, name, round(1080 * 0.88), 190, 3)
        advance = size * LINE_SPACING
        y = top + cell / 2 - (len(lines) * advance) / 2 + advance / 2 + 14
        for text_line in lines:
            draw.text(
                (540, y),
                text_line,
                font=font,
                fill="#FFFFFF",
                anchor="mm",
                stroke_width=max(1, round(size * STROKE_RATIO)),
                stroke_fill="#000000",
            )
            y += advance
        label = load_font("Nunito.ttf", 26)
        draw.text((24, top + 18), name, font=label, fill="#8FA3B8")

    out = os.path.join(DIR, "out", "font-sample.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.save(out)
    print("wrote %s" % out)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    if args[0] == "--font-sample":
        font_sample()
    else:
        render_spec(args[0])
