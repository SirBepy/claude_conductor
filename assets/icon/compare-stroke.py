"""One-off comparison grid: current (unstroked) vs stroked icon, at 16/32/192px,
each over white and dark backgrounds. Scratch tool for todo 535 sign-off, not
part of the regular regen pipeline."""
import sys
from PIL import Image, ImageDraw, ImageFont

from stroke import stroke_at_size

CELL = 200
LABEL_H = 34
ROW_LABEL_W = 90
PAD = 16
SIZES = [16, 32, 192]
BACKS = [("white", (255, 255, 255)), ("dark", (26, 26, 46))]
FONT = ImageFont.truetype("arial.ttf", 15)
FONT_SMALL = ImageFont.truetype("arial.ttf", 13)


def cell_img(icon: Image.Image, size: int, bg: tuple) -> Image.Image:
    small = icon.resize((size, size), Image.LANCZOS)
    plate = Image.new("RGB", (size, size), bg)
    plate.paste(small, (0, 0), small)
    return plate.resize((CELL, CELL), Image.NEAREST)


def main(master_path: str, out_path: str):
    master = Image.open(master_path).convert("RGBA")
    cols = [
        ("CURRENT / white", "current", "white"),
        ("CURRENT / dark", "current", "dark"),
        ("STROKED / white", "stroked", "white"),
        ("STROKED / dark", "stroked", "dark"),
    ]
    width_by_size = {16: 1, 32: 2, 192: 3}

    sheet_w = ROW_LABEL_W + len(cols) * (CELL + PAD) + PAD
    sheet_h = 40 + LABEL_H + len(SIZES) * (CELL + PAD) + PAD
    sheet = Image.new("RGB", (sheet_w, sheet_h), (235, 235, 238))
    draw = ImageDraw.Draw(sheet)
    draw.text((PAD, 10), "todo 535 - baked stroke, icon-master-1024 (16/32/192px)", fill=(20, 20, 20), font=FONT)

    for ci, (label, variant, bgname) in enumerate(cols):
        x = ROW_LABEL_W + ci * (CELL + PAD) + PAD
        draw.text((x, 44), label, fill=(20, 20, 20), font=FONT_SMALL)

    for ri, size in enumerate(SIZES):
        y = 40 + LABEL_H + ri * (CELL + PAD) + PAD
        draw.text((PAD, y + CELL // 2 - 8), f"{size}px", fill=(20, 20, 20), font=FONT)
        for ci, (_, variant, bgname) in enumerate(cols):
            bg = dict(BACKS)[bgname]
            icon = master if variant == "current" else stroke_at_size(master, size, width_by_size[size])
            plate = cell_img(icon, size, bg)
            x = ROW_LABEL_W + ci * (CELL + PAD) + PAD
            sheet.paste(plate, (x, y))
            draw.rectangle([x, y, x + CELL, y + CELL], outline=(120, 120, 120), width=1)

    sheet.save(out_path)
    print(f"-> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
