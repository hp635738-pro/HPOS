#!/usr/bin/env python3
"""Export desktop icons from the finished public/icon.png master.

Optional artwork tooling only; not part of the app's build or runtime.
Requires Pillow: python3 -m pip install Pillow==12.3.0
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PNG_SIZES = (16, 24, 32, 48, 64, 128, 256, 512)
ICO_SIZES = tuple((size, size) for size in PNG_SIZES if size <= 256)


def main():
    master_path = ROOT / "public" / "icon.png"
    with Image.open(master_path) as source:
        if source.format != "PNG" or source.mode != "RGBA":
            raise ValueError("The master must be an RGBA PNG with transparent corners")
        if source.width != source.height or source.width < 512:
            raise ValueError("The master must be square and at least 512 pixels wide")
        if source.getpixel((0, 0))[3] != 0:
            raise ValueError("Remove the background before exporting desktop icons")
        master = source.copy()

    for size in PNG_SIZES:
        destination = ROOT / "design" / "icons" / "hicolor" / f"{size}x{size}" / "apps" / "hpos.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Pillow resamples RGBA in premultiplied-alpha space to avoid edge halos.
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(destination, format="PNG", optimize=True)
        print(destination.relative_to(ROOT))

    destination = ROOT / "public" / "icon.ico"
    master.save(destination, format="ICO", sizes=ICO_SIZES, bitmap_format="png")
    print(destination.relative_to(ROOT))


if __name__ == "__main__":
    main()
