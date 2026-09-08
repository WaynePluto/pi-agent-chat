"""为扩展生成 ``media/icon.png``。

图标刻意采用扁平双色设计：``#24abf2`` 圆角方块、带左下尾巴的白色聊天气泡、
蓝色 pi 字形。先按放大尺寸绘制再降采样，得到干净的边缘。

在仓库根目录运行::

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

BACKGROUND = (36, 171, 242, 255)  # 背景色 #24abf2
BUBBLE = (249, 252, 255, 255)
PI_INK = (16, 112, 174, 255)


def scale_box(values: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """把图标逻辑坐标系的包围盒缩放到渲染画布。"""
    return tuple(round(value * SCALE) for value in values)  # type: ignore[return-value]


def scale_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    """把图标逻辑坐标系的点缩放到渲染画布。"""
    return [(round(x * SCALE), round(y * SCALE)) for x, y in points]


def pi_font() -> ImageFont.FreeTypeFont:
    """加载定稿 pi 字形所用的字体。

    Cambria 在 Windows 开发环境自带，其小写希腊 pi 形态清晰可辨，正是 PNG
    里用的形状；环境变量覆盖保证字体装在非常规位置时脚本仍可用。
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

    # 扁平的圆角方块背景。
    draw.rounded_rectangle(
        scale_box((0, 0, ICON_SIZE, ICON_SIZE)),
        radius=28 * SCALE,
        fill=BACKGROUND,
    )

    # 实心聊天气泡。宽大的左下尾巴与气泡同属一个形状，读起来才不像
    # 单独的裂口或装饰。
    draw.rounded_rectangle(
        scale_box((16, 24, 112, 88)),
        radius=20 * SCALE,
        fill=BUBBLE,
    )
    draw.polygon(
        scale_points([(27, 76), (27, 104), (53, 80)]),
        fill=BUBBLE,
    )

    # 居中的小写希腊 pi。
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
