# HPOS application icon

A centered geometric H in ice-blue frosted glass, on a deep graphite rounded
square. Two upright panes and a connecting bridge subtly suggest linked
workspaces. A slim edge, soft contact shadow and restrained cyan light provide
depth without extra symbols or text.

## Assets

| File | Purpose |
| --- | --- |
| [`../../public/icon.png`](../../public/icon.png) | **Primary artwork.** 1024 × 1024 RGBA PNG, transparent outside the rounded tile. Used by Electron windows and Linux packaging. |
| [`hicolor/`](hicolor/) | Transparent PNG exports at 16, 24, 32, 48, 64, 128, 256 and 512 px, in the Linux icon-theme directory layout. |
| [`../../public/icon.ico`](../../public/icon.ico) | Matching Windows icon, containing 16/24/32/48/64/128/256 px PNG entries. |
| [`../../public/icon.svg`](../../public/icon.svg) | Editable, independently drawn vector companion with the same silhouette and palette. Not the source of the rendered PNG. |
| [`../../public/favicon.svg`](../../public/favicon.svg) | Simplified vector companion for browser tabs and other tiny placements. |

The primary artwork is an AI-assisted render with a finished transparent matte.
The SVG companions are native paths; they contain no embedded raster images,
fonts or external resources. All files use the H alone, without a wordmark.
Keep the transparent padding; do not stretch the tile or place a second rounded
rectangle behind it.

## Regenerate raster exports

The finished `public/icon.png` is the canonical raster master. After replacing
it, run from the repository root:

```sh
# Optional design tooling, not a production dependency. Use a virtualenv if needed.
python3 -m pip install Pillow==12.3.0
python3 scripts/export-icons.py
node packaging.test.mjs
```

This updates the hicolor PNGs and Windows ICO without modifying the master or
SVG companions. When changing the design itself, update the two SVG companions
separately to keep their geometry and colors aligned.

## Linux use

Existing `build.linux.icon` and `linuxWindowIcon()` already use `public/icon.png`;
no package or runtime configuration changes are required. Electron-builder
creates the packaged icon sizes from that master.

For a manually installed launcher, copy the contents of `hicolor/` into
`~/.local/share/icons/hicolor/` and set `Icon=hpos` in its desktop entry. The app's
packaged AppImage and deb builds manage their own icons, so this manual step is
not needed for those builds.
