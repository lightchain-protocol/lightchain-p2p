"""
Draws the macOS installer window's background: the site's dark page, the
Lightchain mark, one line saying what to do, and the brand-gradient arrow
from the app to Applications.

    python3 scripts/build-dmg-background.py

Writes build/dmg-background.png (660x420) and its @2x. The icon positions in
forge.config.js's DMG maker are drawn to match: app at (170, 250),
Applications at (490, 250). Needs Pillow; fonts are Inter from build/fonts.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BUILD = Path(__file__).resolve().parent.parent / "build"
W, H = 660, 420


def draw(scale):
    w, h = W * scale, H * scale
    img = Image.new("RGBA", (w, h), (7, 7, 16, 255))  # --color-dark

    # The site modal's primary blur in the top-left corner (.top-flashlight).
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-140 * scale, -160 * scale, 300 * scale, 120 * scale), fill=(91, 75, 255, 90))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(90 * scale)))

    d = ImageDraw.Draw(img)
    # The mark, small, above the line.
    mark = Image.open(BUILD / "symbol.png").convert("RGBA")
    mark.thumbnail((34 * scale, 34 * scale), Image.LANCZOS)
    img.paste(mark, ((w - mark.width) // 2, 34 * scale), mark)

    title = ImageFont.truetype(str(BUILD / "fonts" / "Inter_24pt-SemiBold.ttf"), 20 * scale)
    body = ImageFont.truetype(str(BUILD / "fonts" / "Inter_18pt-Regular.ttf"), 13 * scale)
    def centred(text, font, y, fill):
        width = d.textlength(text, font=font)
        d.text(((w - width) / 2, y), text, font=font, fill=fill)
    centred("Drag Lightchain Chat into Applications", title, 86 * scale, (245, 246, 255, 255))
    centred("Then open it from Launchpad or Spotlight.", body, 118 * scale, (177, 179, 208, 255))

    # The arrow, in the button gradient #df04ae -> #412ffd.
    x0, x1, y = 250 * scale, 410 * scale, 250 * scale
    grad = Image.new("RGBA", (x1 - x0 + 14 * scale, 24 * scale))
    for x in range(grad.width):
        t = x / max(1, grad.width - 1)
        c = tuple(int(a + (b - a) * t) for a, b in zip((223, 4, 174), (65, 47, 253))) + (255,)
        ImageDraw.Draw(grad).line((x, 0, x, grad.height), fill=c)
    shape = Image.new("L", grad.size, 0)
    sd = ImageDraw.Draw(shape)
    mid = grad.height // 2
    sd.rounded_rectangle((0, mid - 2 * scale, grad.width - 14 * scale, mid + 2 * scale), 2 * scale, fill=255)
    sd.polygon([(grad.width - 20 * scale, 2 * scale), (grad.width, mid), (grad.width - 20 * scale, grad.height - 2 * scale)], fill=255)
    img.paste(grad, (x0, y - mid), shape)

    out = BUILD / ("dmg-background@2x.png" if scale == 2 else "dmg-background.png")
    img.convert("RGB").save(out, dpi=(72 * scale, 72 * scale))
    return out


for s in (1, 2):
    print("wrote", draw(s).name)
