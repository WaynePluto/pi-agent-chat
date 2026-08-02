"""Generate ``media/icon.png`` for the Pi Agent Chat extension.

The icon is intentionally a flat, two-colour design: a ``#24abf2`` rounded
square, a white chat bubble with a lower-left tail, and a blue pi glyph.
The artwork is rendered at a larger size and downsampled for clean edges.

Run from the repository root with::

    python scripts/make_icon.py
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ICON_SIZE = 128
SCALE = 6
CANVAS_SIZE = ICON_SIZE * SCALE
OUTPUT = Path(__file__).resolve().parent.parent / "media" / "icon.png"

BACKGROUND = (36, 171, 242, 255)  # #24abf2
BUBBLE = (249, 252, 255, 255)
PI_INK = (16, 112, 174, 255)


def scale_box(values: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """Scale a logical icon-space bounding box to the render canvas."""
    return tuple(round(value * SCALE) for value in values)  # type: ignore[return-value]


def scale_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    """Scale logical icon-space points to the render canvas."""
    return [(round(x * SCALE), round(y * SCALE)) for x, y in points]


def pi_font() -> ImageFont.FreeTypeFont:
    """Load the font used for the approved pi glyph design.

    Cambria is available on the Windows development environment and gives the
    lowercase Greek pi the distinctive, readable shape used in the PNG. An
    environment override keeps the script usable if the font is installed in
    a non-standard location.
    """
    override = os.environ.get("PI_ICON_FONT")
    candidates = [
        Path(override) if override else None,
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "cambria.ttc",
        Path("/usr/share/fonts/truetype/msttcorefonts/Cambria.ttf"),
        Path("/usr/share/fonts/truetype/msttcorefonts/cambria.ttf"),
    ]

    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return ImageFont.truetype(str(candidate), 56 * SCALE)

    searched = ", ".join(str(path) for path in candidates if path is not None)
    raise FileNotFoundError(
        "Could not find the Cambria font used for the pi glyph. "
        f"Install it or set PI_ICON_FONT to a font file. Searched: {searched}"
    )


def main() -> None:
    image = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Flat rounded-square background.
    draw.rounded_rectangle(
        scale_box((0, 0, ICON_SIZE, ICON_SIZE)),
        radius=28 * SCALE,
        fill=BACKGROUND,
    )

    # Filled speech bubble. The broad lower-left tail is part of the same
    # shape, so it does not read as a separate tear or decorative mark.
    draw.rounded_rectangle(
        scale_box((16, 24, 112, 88)),
        radius=20 * SCALE,
        fill=BUBBLE,
    )
    draw.polygon(
        scale_points([(27, 76), (27, 104), (53, 80)]),
        fill=BUBBLE,
    )

    # Centered lowercase Greek pi.
    draw.text(
        (64 * SCALE, 56 * SCALE),
        "π",
        font=pi_font(),
        anchor="mm",
        fill=PI_INK,
    )

    result = image.resize((ICON_SIZE, ICON_SIZE), Image.Resampling.LANCZOS)
    result.save(OUTPUT, optimize=True)
    print(f"wrote {OUTPUT}")


if __name__ == "__main__":
    main()
