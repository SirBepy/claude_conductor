"""Composite the transparent icon over the backgrounds it will actually land on."""
import sys
from PIL import Image

BACKS = [
    ("white tab", (255, 255, 255)),
    ("light taskbar", (243, 243, 243)),
    ("dark taskbar", (32, 32, 32)),
    ("app navy", (26, 26, 46)),
]
ZOOM = 8
SIZES = [32, 192]
PAD = 24


def main(out, src):
    icon = Image.open(src).convert("RGBA")
    cells = [(s * ZOOM if s == 32 else s) for s in SIZES]
    row_w = PAD + sum(c + PAD for c in cells)
    sheet = Image.new("RGB", (row_w, PAD + len(BACKS) * (max(cells) + PAD)), (200, 200, 205))

    for ri, (_, colour) in enumerate(BACKS):
        y = PAD + ri * (max(cells) + PAD)
        x = PAD
        for si, s in enumerate(SIZES):
            small = icon.resize((s, s), Image.LANCZOS)
            plate = Image.new("RGB", (s, s), colour)
            plate.paste(small, (0, 0), small)
            if s == 32:
                plate = plate.resize((s * ZOOM, s * ZOOM), Image.NEAREST)
            sheet.paste(plate, (x, y))
            x += cells[si] + PAD

    sheet.save(out)
    print(f"{[b[0] for b in BACKS]} x {SIZES} -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
