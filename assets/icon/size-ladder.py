"""Contact sheet: each candidate rendered at real icon sizes, the only honest icon test."""
import sys
from PIL import Image

SIZES = [192, 96, 48, 32]
PAD = 28
BG = (245, 245, 248)


def main(out, paths):
    cols = len(paths)
    row_h = max(SIZES) + PAD
    sheet = Image.new("RGB", (cols * (max(SIZES) + PAD) + PAD, row_h * len(SIZES)), BG)

    for ci, p in enumerate(paths):
        img = Image.open(p).convert("RGB")
        for ri, s in enumerate(SIZES):
            small = img.resize((s, s), Image.LANCZOS)
            x = PAD + ci * (max(SIZES) + PAD) + (max(SIZES) - s) // 2
            y = ri * row_h + (row_h - s) // 2
            sheet.paste(small, (x, y))

    sheet.save(out)
    print(f"{len(paths)} candidates x {SIZES} -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
