"""Generate media/icon.png (128x128 marketplace icon) with PIL.

Design: rounded-square VS Code blue gradient tile, white chat bubble, pi glyph.
Drawn at 8x and downsampled for anti-aliasing. Re-run after design changes:

    python scripts/make_icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

SCALE = 8
SIZE = 128 * SCALE
OUT = Path(__file__).resolve().parent.parent / "media" / "icon.png"


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Vertical gradient tile (VS Code brand blues: light #2C9DF2-ish -> deep #0E639C/#005A9E),
    # rounded corners.
    top, bottom = (44, 157, 242), (0, 68, 130)
    gradient = Image.new("RGBA", (SIZE, SIZE))
    gdraw = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        gdraw.line([(0, y), (SIZE, y)], fill=lerp(top, bottom, y / SIZE) + (255,))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=SIZE // 5, fill=255)
    img.paste(gradient, (0, 0), mask)

    # Chat bubble (white outline), tail pointing bottom-left.
    white = (255, 255, 255, 255)
    stroke = 7 * SCALE

    def pt(x: float, y: float) -> tuple:
        return (x * SCALE, y * SCALE)

    bubble = [pt(24, 26), pt(104, 78)]  # rounded rect of the bubble body
    draw.rounded_rectangle(bubble, radius=16 * SCALE, outline=white, width=stroke)
    # Tail: triangle from bubble bottom edge to lower-left.
    draw.polygon([pt(34, 74), pt(56, 74), pt(30, 98)], fill=white)
    # Erase the seam between tail and bubble border by refilling the overlap.
    draw.rounded_rectangle(
        [pt(24 + 7, 26 + 7), pt(104 - 7, 78 - 7)],
        radius=11 * SCALE,
        fill=lerp((44, 157, 242), (0, 68, 130), 0.5) + (0,),
    )
    # Repaint bubble interior with the gradient (keep outline + tail).
    interior = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(interior).rounded_rectangle(
        [pt(24 + 7, 26 + 7), pt(104 - 7, 78 - 7)], radius=11 * SCALE, fill=255
    )
    img.paste(gradient, (0, 0), interior)

    # Pi glyph inside the bubble.
    draw = ImageDraw.Draw(img)
    pi_stroke = 6 * SCALE
    # top bar with a slight overhang
    draw.line([pt(42, 42), pt(86, 42)], fill=white, width=pi_stroke)
    # two straight legs (clean shape stays readable at 16px)
    draw.line([pt(52, 42), pt(52, 64)], fill=white, width=pi_stroke)
    draw.line([pt(76, 42), pt(76, 64)], fill=white, width=pi_stroke)
    # round the line caps
    for cx, cy in [(42, 42), (86, 42), (52, 64), (76, 64)]:
        r = pi_stroke // 2
        draw.ellipse([cx * SCALE - r, cy * SCALE - r, cx * SCALE + r, cy * SCALE + r], fill=white)

    img = img.resize((128, 128), Image.LANCZOS)
    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
