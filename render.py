"""
Slide renderer for the TikTok photo-carousel pipeline.

    python render.py <spec.json>
    python render.py --font-sample     # candidate-font contact sheet
    python render.py --calibrate <dir> # re-derive the ratios from reference slides

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

EMBOLDEN_RATIO, AND WHY IT IS ZERO
----------------------------------
The reference slides were described as Archivo Black with bold applied on top,
so this draws each line twice to be able to reproduce that: once in black at
stroke_width EMBOLDEN + OUTLINE for the silhouette, then once in white at
stroke_width EMBOLDEN for the letterform. A stroke in the same colour as the
fill is a faux-bold, which Pillow has no other way to do.

Measuring the references settled it the other way. Their stems come out about
7% LIGHTER than plain Archivo Black relative to line height, so any
emboldening at all overshoots. EMBOLDEN_RATIO is 0 and the second pass
collapses to an ordinary draw. The machinery stays because the finding is
about these particular slides, not about the template: set the ratio to
something like 0.006 and the weight comes back, evenly, at every font size.

Requires Pillow (`pip install Pillow`).
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

DIR = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(DIR, "fonts")

# ---- template constants ----
# Measured off 32 reference slides with `--calibrate`, not guessed. Everything
# there is normalised against stem width, so it transfers cleanly even though
# the references are 1179x1949 and these render at 1080x1920:
#
#     outline / stem     0.429      line advance / stem     7.714
#
# Archivo Black's stem is 0.1950em, which is what converts those into the
# per-em ratios below. Re-run `python render.py --calibrate <folder>` against
# both the references and a folder of fresh output to check the drift.
CANVAS = (1080, 1920)
TEXT_WIDTH_PCT = 0.90     # text box width as a fraction of canvas width
LINE_SPACING = 1.478      # line advance as a multiple of font size
STROKE_RATIO = 0.081      # BLACK outline width as a multiple of font size
EMBOLDEN_RATIO = 0.0      # faux-bold before the outline; see the docstring
MAX_LINES = 4             # past 4 lines the slide stops being skimmable
MIN_FONT = 28

# Type size is CAPPED, not merely maximised, and the cap is measured.
#
# --calibrate only ever reports ratios normalised to stem width, and those are
# scale-invariant by design, so nothing here had ever measured how big the type
# actually is. The fitter simply took the largest size that fit the box, which
# meant a short item ballooned: "1. You skip recovery days" rendered at 200px,
# nearly double anything the account has posted.
#
# Measured across the 24 legible non-promo reference slides, type lands at
# 0.065-0.111 of canvas width. Restricted to the item slides whose text is
# known, the median is 0.102 - so that is the ceiling. Longer copy still shrinks
# below it exactly as before; the cap only stops short copy running away.
#
# A fraction of width rather than a pixel count, to match TEXT_WIDTH_PCT and
# LAYOUT_HEIGHT_PCT and so the template survives a canvas change.
MAX_FONT_PCT = 0.102      # ~110px on a 1080-wide canvas

# Vertical placement of the text block's CENTRE, per layout. `center` sits just
# above the true middle because the eye reads a centred block as low when the
# subject's face is in the upper third - which it is in every football wallpaper.
LAYOUT_CENTRE = {
    "center": 0.49,
    "top": 0.183,
    "bottom": 0.74,
}
# Height budget for the text block, per layout. `top` gets less because the CTA
# slide has to leave the bottom two thirds for the app screenshot.
LAYOUT_HEIGHT_PCT = {
    "center": 0.46,
    "top": 0.30,
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


def ink_padding(size):
    """How far the drawn glyph spills past its layout box, each side.

    Emboldening and the outline both grow outward from the letterform, so a
    line wrapped to exactly box_w renders wider than box_w. Fitting without
    this is how type ends up touching the frame edge on the longest line.
    """
    return round(size * (EMBOLDEN_RATIO + STROKE_RATIO))


def draw_stroked_line(draw, xy, text, font, fill, stroke_fill, size):
    """One line of the house treatment: white fill inside a black outline.

    Two passes so EMBOLDEN_RATIO can fatten the letterform independently of the
    outline - see EMBOLDEN_RATIO, AND WHY IT IS ZERO in the module docstring.
    """
    embolden = round(size * EMBOLDEN_RATIO)
    outline = max(1, round(size * STROKE_RATIO))
    if outline + embolden > 0:
        draw.text(
            xy, text, font=font, fill=stroke_fill, anchor="mm",
            stroke_width=outline + embolden, stroke_fill=stroke_fill,
        )
    if embolden > 0:
        draw.text(
            xy, text, font=font, fill=fill, anchor="mm",
            stroke_width=embolden, stroke_fill=fill,
        )
    else:
        draw.text(xy, text, font=font, fill=fill, anchor="mm")


def fit_text(draw, text, font_name, box_w, box_h, max_lines=MAX_LINES, max_font=None):
    """Largest font size whose wrapped text fits the box, budget and size cap.

    `max_font` is the measured ceiling (see MAX_FONT_PCT). It is a real
    constraint rather than a safety rail: most item slides now hit it, because
    short copy would otherwise fit the box at a size the account never uses.
    """
    if max_font is None:
        max_font = round(CANVAS[0] * MAX_FONT_PCT)
    best = None
    lo, hi = MIN_FONT, max(MIN_FONT, max_font)
    while lo <= hi:
        mid = (lo + hi) // 2
        font = load_font(font_name, mid)
        lines = wrap(text, font, box_w - 2 * ink_padding(mid), draw)
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
        usable = box_w - 2 * ink_padding(MIN_FONT)
        return MIN_FONT, wrap(text, font, usable, draw) or [text], font
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


def paste_clipped(canvas, layer, x, y):
    """alpha_composite that tolerates an overlay hanging off the frame.

    Pillow's alpha_composite refuses a layer that does not fit entirely inside
    the destination, and the promo slide deliberately runs the phone shot past
    the edge. Trim to the visible rectangle first and the bleed is free.
    """
    left, top = max(0, -x), max(0, -y)
    right = min(layer.width, canvas.width - x)
    bottom = min(layer.height, canvas.height - y)
    if right <= left or bottom <= top:
        return  # entirely off-frame
    if (left, top, right, bottom) != (0, 0, layer.width, layer.height):
        layer = layer.crop((left, top, right, bottom))
    canvas.alpha_composite(layer, (x + left, y + top))


def draw_slide(slide, spec):
    width, height = spec.get("width", CANVAS[0]), spec.get("height", CANVAS[1])
    font_name = spec.get("font", "ArchivoBlack.ttf")

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
        paste_clipped(canvas, layer, x, y)

    draw = ImageDraw.Draw(canvas)
    text = (slide.get("text") or "").strip()
    if text:
        layout = slide.get("layout", "center")
        box_w = round(width * TEXT_WIDTH_PCT)
        box_h = round(height * LAYOUT_HEIGHT_PCT.get(layout, 0.46))
        max_lines = int(slide.get("maxLines", MAX_LINES))
        # Derived from the actual canvas, not the constant, so a spec that
        # renders at another size keeps the same proportions.
        max_font = round(width * MAX_FONT_PCT)
        size, lines, font = fit_text(draw, text, font_name, box_w, box_h, max_lines, max_font)

        # textScale trims the fitted size without re-wrapping, so the line
        # breaks a human approved do not move. Used on the hook slide, which is
        # the carousel's cover and gets re-cropped by TikTok in the feed and on
        # the profile grid.
        scale = float(slide.get("textScale", 1.0))
        if scale != 1.0:
            size = max(MIN_FONT, round(size * scale))
            font = load_font(font_name, size)

        advance = size * LINE_SPACING
        block_h = len(lines) * advance
        centre_y = height * LAYOUT_CENTRE.get(layout, 0.49)
        y = centre_y - block_h / 2 + advance / 2

        for line in lines:
            draw_stroked_line(
                draw,
                (width / 2, y),
                line,
                font,
                slide.get("color", "#FFFFFF"),
                slide.get("strokeColor", "#000000"),
                size,
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
            draw_stroked_line(draw, (540, y), text_line, font, "#FFFFFF", "#000000", size)
            y += advance
        label = load_font("ArchivoBlack.ttf", 22)
        draw.text((24, top + 18), name, font=label, fill="#8FA3B8")

    out = os.path.join(DIR, "out", "font-sample.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.save(out)
    print("wrote %s" % out)


def _text_bands(image):
    """Rows of near-white ink, grouped into lines. Shared by every measurement.

    Near-white and near-black rather than exact: these come back as JPEGs, so
    the type is ringed with compression noise and nothing is #FFFFFF any more.
    """
    import numpy as np

    array = np.asarray(image.convert("RGB")).astype(np.int16)
    white = array.min(axis=2) > 235
    black = array.max(axis=2) < 45
    width = image.width

    rows = np.where(white.sum(axis=1) > width * 0.02)[0]
    if len(rows) == 0:
        return white, black, []

    bands, start, prev = [], rows[0], rows[0]
    for row in rows[1:]:
        if row - prev > 3:
            bands.append((start, prev))
            start = row
        prev = row
    bands.append((start, prev))
    return white, black, bands


def stem_width_em(font_name="ArchivoBlack.ttf"):
    """Vertical stem thickness of this font, as a fraction of its em size.

    The bridge between what can be measured off a finished JPEG (pixels of
    white) and what this file is written in (fractions of a font size).
    """
    import statistics

    size = 200
    font = load_font(font_name, size)
    probe = Image.new("RGB", (size * 12, size * 3), (0, 0, 0))
    draw = ImageDraw.Draw(probe)
    draw.text((probe.width / 2, probe.height / 2), "minimum",
              font=font, fill="#FFFFFF", anchor="mm")
    return statistics.median(_stem_runs(probe)) / size


def _stem_runs(image):
    """White run lengths across the x-height zone - one sample per stem crossed."""
    import numpy as np

    array = np.asarray(image.convert("RGB")).astype(np.int16)
    white = array.min(axis=2) > 235
    rows = np.where(white.any(axis=1))[0]
    if len(rows) == 0:
        return [1]
    top, bottom = rows[0], rows[-1]
    height = bottom - top + 1
    runs = []
    for y in range(top + int(height * 0.35), top + int(height * 0.72)):
        row = white[y]
        x = 0
        while x < image.width:
            if row[x]:
                start = x
                while x < image.width and row[x]:
                    x += 1
                if 2 <= x - start <= height:
                    runs.append(x - start)
            else:
                x += 1
    return runs or [1]


def calibrate(sample_dir):
    """Re-derive the template ratios from a folder of reference slides.

    Everything is normalised against STEM WIDTH - the thickness of a vertical
    stroke - and not against the height of a line. Line height was the obvious
    choice and it is wrong: a line reads shorter when its words happen to carry
    no descender, so the same template measures differently depending on whether
    the copy says "your recovery" or "recover". Stem width is there on every
    line of every slide and does not move.

    Prints what the samples say next to what this file currently does. It writes
    nothing - read the numbers and edit the constants at the top.
    """
    import statistics

    import numpy as np

    files = [
        os.path.join(sample_dir, f)
        for f in sorted(os.listdir(sample_dir))
        if f.lower().endswith((".jpg", ".jpeg", ".png"))
    ]
    if not files:
        raise SystemExit("no images in %s" % sample_dir)

    outline_ratios, advance_ratios = [], []
    for path in files:
        image = Image.open(path)
        width = image.width
        white, black, bands = _text_bands(image)
        # Under 55px is a watermark or JPEG noise; over 130 is two lines that
        # touched and merged. Neither can be measured.
        lines = [b for b in bands if 55 < b[1] - b[0] < 130]
        if not lines:
            continue

        stems, outlines = [], []
        for y0, y1 in lines:
            height = y1 - y0 + 1
            for y in range(y0 + int(height * 0.35), y0 + int(height * 0.72)):
                xs = np.where(white[y])[0]
                if len(xs) == 0:
                    continue
                # Outline: walk outward from the outermost white pixel through
                # the black ringing it. Only the outer edges - black BETWEEN two
                # letters is two outlines meeting and measures double.
                for x_start, step in ((xs[0] - 1, -1), (xs[-1] + 1, 1)):
                    x, run = x_start, 0
                    while 0 <= x < width and black[y][x]:
                        run += 1
                        x += step
                    if 2 <= run <= 40:
                        outlines.append(run)
                x = 0
                while x < width:
                    if white[y][x]:
                        start = x
                        while x < width and white[y][x]:
                            x += 1
                        if 4 <= x - start <= 60:
                            stems.append(x - start)
                    else:
                        x += 1
        if len(stems) < 8:
            continue
        stem = statistics.median(stems)
        if outlines:
            outline_ratios.append(statistics.median(outlines) / stem)

        tops = [b[0] for b in lines]
        for i in range(len(tops) - 1):
            gap = tops[i + 1] - tops[i]
            if stem * 3 < gap < stem * 14:
                advance_ratios.append(gap / stem)

    stem_em = stem_width_em()
    here_outline = STROKE_RATIO / stem_em
    here_advance = LINE_SPACING / stem_em

    print("measured %d slides in %s" % (len(files), sample_dir))
    print("(Archivo Black stem = %.4f em)" % stem_em)
    print("")
    print("  %-24s %-22s %s" % ("", "these slides", "what this file does"))
    for label, values, current in (
        ("outline / stem", outline_ratios, here_outline),
        ("line advance / stem", advance_ratios, here_advance),
    ):
        if not values:
            print("  %-24s no usable samples" % label)
            continue
        measured = statistics.median(values)
        print("  %-24s %-6.3f (n=%-4d)      %.3f   [x%.2f]"
              % (label, measured, len(values), current, measured / current))
    print("")
    print("To adopt a column, multiply it by %.4f and write it into" % stem_em)
    print("STROKE_RATIO / LINE_SPACING at the top of this file.")

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    if args[0] == "--font-sample":
        font_sample()
    elif args[0] == "--calibrate":
        if len(args) < 2:
            raise SystemExit("usage: python render.py --calibrate <folder-of-slides>")
        calibrate(args[1])
    else:
        render_spec(args[0])
