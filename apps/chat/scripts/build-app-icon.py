"""
Draws the application icon: the Lightchain symbol without its wordmark, on a
dark rounded tile.

    python3 scripts/build-app-icon.py

The symbol is the presale site's own (LCAIPresale
`public/images/logo-no-text.png`, copied to `build/symbol.png`). The tile is
the site's Neutral-900 with the ecosystem card's pale edge and a faint primary
glow, on Apple's icon grid - an 824px tile in a 1024px canvas - so it sits
among other apps at the right size. Writes build/icon.png, icon.icns,
icon.ico and build/icon/*. Needs Pillow.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

BUILD = Path(__file__).resolve().parent.parent / "build"
CANVAS, TILE, RADIUS, MARK = 1024, 824, 185, 500
INSET = (CANVAS - TILE) // 2

icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

# The tile: Neutral-900, with a soft #5b4bff glow behind the mark.
tile = Image.new("RGBA", (TILE, TILE), (15, 15, 20, 255))
glow = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse((TILE * 0.18, TILE * 0.12, TILE * 0.82, TILE * 0.76), fill=(91, 75, 255, 70))
tile = Image.alpha_composite(tile, glow.filter(ImageFilter.GaussianBlur(110)))

mask = Image.new("L", (TILE, TILE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, TILE - 1, TILE - 1), RADIUS, fill=255)
icon.paste(tile, (INSET, INSET), mask)

# The ecosystem card's edge, rgba(204,206,239,.2).
edge = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
ImageDraw.Draw(edge).rounded_rectangle(
    (INSET, INSET, INSET + TILE - 1, INSET + TILE - 1), RADIUS, outline=(204, 206, 239, 51), width=4
)
icon = Image.alpha_composite(icon, edge)

symbol = Image.open(BUILD / "symbol.png").convert("RGBA")
symbol.thumbnail((MARK, MARK), Image.LANCZOS)
layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
layer.paste(symbol, ((CANVAS - symbol.width) // 2, (CANVAS - symbol.height) // 2), symbol)
icon = Image.alpha_composite(icon, layer)

icon.save(BUILD / "icon.icns")
icon.save(BUILD / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
icon.resize((512, 512), Image.LANCZOS).save(BUILD / "icon.png")
for size in (16, 32, 64, 128, 256):
    icon.resize((size, size), Image.LANCZOS).save(BUILD / "icon" / f"icon-{size}x{size}.png")
print("wrote build/icon.png, icon.icns, icon.ico and build/icon/*")
