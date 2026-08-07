"""Normalise the chosen artwork into a square 1024 transparent master for `tauri icon`."""
import sys
from PIL import Image

CANVAS = 1024


def main():
    src, out = sys.argv[1:3]
    frac = float(sys.argv[3]) if len(sys.argv) > 3 else 0.96

    art = Image.open(src).convert("RGBA")
    art = art.crop(art.split()[3].getbbox())
    scale = (CANVAS * frac) / max(art.size)
    art = art.resize((max(1, int(art.width * scale)), max(1, int(art.height * scale))), Image.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(art, ((CANVAS - art.width) // 2, (CANVAS - art.height) // 2), art)
    canvas.save(out)
    print(f"master {art.size} at frac={frac} -> {out}")


if __name__ == "__main__":
    main()
