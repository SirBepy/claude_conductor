"""Bake a dark stroke/halo onto the transparent master, per target size, for
surfaces that can't detect theme at runtime (PWA/Android launcher icons).
Mirrors the shadow-stack trick used at runtime in favicon-badge.ts."""
import sys
from PIL import Image, ImageFilter

STROKE_COLOR = (22, 21, 31)  # #16151f


def stroke_at_size(master: Image.Image, size: int, width: int) -> Image.Image:
    icon = master.resize((size, size), Image.LANCZOS)
    alpha = icon.split()[3]
    dilated = alpha.filter(ImageFilter.MaxFilter(width * 2 + 1))
    halo = Image.new("RGBA", icon.size, STROKE_COLOR + (0,))
    halo.putalpha(dilated)
    return Image.alpha_composite(halo, icon)


def main():
    src, out, size_s, width_s = sys.argv[1:5]
    master = Image.open(src).convert("RGBA")
    stroke_at_size(master, int(size_s), int(width_s)).save(out)
    print(f"{size_s}px stroke width={width_s} -> {out}")


if __name__ == "__main__":
    main()
