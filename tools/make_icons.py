"""Generate SpectraLab app icons (PWA). ASCII-only source."""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "web", "icons")
os.makedirs(OUT, exist_ok=True)

# spectrum stops (violet -> cyan -> green -> amber -> red)
STOPS = [
    (0.00, (124, 92, 255)),
    (0.28, (34, 211, 238)),
    (0.55, (52, 211, 153)),
    (0.78, (245, 158, 11)),
    (1.00, (251, 113, 133)),
]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def spectrum_color(t):
    t = max(0.0, min(1.0, t))
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t0 <= t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return STOPS[-1][1]


def make(size, maskable=False):
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # background: rounded square (or full bleed for maskable)
    bg = Image.new("RGBA", (S, S), (7, 10, 20, 255))
    if maskable:
        img.paste(bg, (0, 0))
    else:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
        img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # soft glow behind the spectrum bar
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    y0, y1 = int(S * 0.42), int(S * 0.58)
    gd.rounded_rectangle([int(S * 0.12), y0, int(S * 0.88), y1], radius=int(S * 0.08), fill=(120, 100, 255, 140))
    glow = glow.filter(ImageFilter.GaussianBlur(int(S * 0.05)))
    img.alpha_composite(glow)

    # spectrum bar
    bx0, bx1 = int(S * 0.14), int(S * 0.86)
    by0, by1 = int(S * 0.45), int(S * 0.55)
    bar_h = by1 - by0
    r = bar_h // 2
    for x in range(bx0, bx1):
        t = (x - bx0) / max(1, (bx1 - bx0 - 1))
        c = spectrum_color(t)
        # rounded ends
        yy0, yy1 = by0, by1
        if x < bx0 + r:
            dx = (bx0 + r) - x
            dy = int((r * r - dx * dx) ** 0.5)
            yy0, yy1 = by0 + (r - dy), by1 - (r - dy)
        elif x > bx1 - r:
            dx = x - (bx1 - r)
            dy = int((r * r - dx * dx) ** 0.5)
            yy0, yy1 = by0 + (r - dy), by1 - (r - dy)
        d.line([(x, yy0), (x, yy1)], fill=c + (255,))

    # spectral lines (white), crossing the bar
    lines = [(0.30, 0.30, 0.72, 0.028), (0.52, 0.34, 0.68, 0.020), (0.70, 0.27, 0.75, 0.016)]
    for cx, top, bot, wid in lines:
        x = int(S * (0.14 + cx * 0.72))
        hw = max(2, int(S * wid * 0.5))
        d.rounded_rectangle(
            [x - hw, int(S * top), x + hw, int(S * bot)],
            radius=hw,
            fill=(240, 244, 252, 245),
        )

    # subtle inner border
    if not maskable:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), outline=(255, 255, 255, 26), width=max(1, S // 200))

    return img.resize((size, size), Image.LANCZOS)


for size in (192, 512):
    make(size).save(os.path.join(OUT, f"icon-{size}.png"))
make(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
print("icons written to", os.path.abspath(OUT))
