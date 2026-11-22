"""Team plugins icon: three isometric boxes stacked (a shared stock of plugins) in white on a blue rounded square.
Each box is three faces separated by thin gaps, with a tape gap across the lid. Drawn entirely here, from no source
image, so the icon is covered by the repository's licence.

Run from the repository root: uv run --with pillow python scripts/make_icon.py  (writes resources/icon.png, 256 px)
"""
import math
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "resources/icon.png"
N = 256  # output size
S = 8  # supersampling
W = N * S
TOP = (47, 111, 176)  # background gradient, top to bottom
BOTTOM = (24, 62, 108)
CORNER = 0.22  # rounding of the background square, as a fraction of its size

R = W * 0.19  # box: distance from its centre to its outer corners
BOX_CORNER = 0.07  # rounding of a box's outer corners, as a fraction of R
FACE_GAP = 0.08  # gap between the faces and of the tape, as a fraction of R
STACK_GAP = W * 0.025  # space between the boxes


def background():
    grad = Image.new("RGBA", (W, W))
    d = ImageDraw.Draw(grad)
    for y in range(W):
        t = y / (W - 1)
        d.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * CORNER), fill=255)
    out = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def draw_box(d, cx, cy):
    """One box on the mask: centre (cx, cy), corners pointing up and down."""
    cr = R * BOX_CORNER
    gap = R * FACE_GAP

    def pt(angle_deg, radius):
        a = math.radians(angle_deg)
        return (cx + radius * math.cos(a), cy + radius * math.sin(a))

    # rounded silhouette: the hexagon shrunk by the corner radius, filled and outlined with round joins
    inner = [pt(a, R - cr / math.cos(math.radians(30))) for a in (270, 330, 30, 90, 150, 210)]
    d.polygon(inner, fill=255)
    d.line(inner + [inner[0]], fill=255, width=int(2 * cr), joint="curve")
    for p in inner:
        d.ellipse([p[0] - cr, p[1] - cr, p[0] + cr, p[1] + cr], fill=255)
    # gaps between the faces: from the centre to the upper-left, upper-right and bottom corners, a little past the
    # silhouette so each gap opens cleanly at the edge
    for a in (210, 330, 90):
        d.line([(cx, cy), pt(a, R * 1.1)], fill=0, width=int(gap))
    # tape across the lid: from the middle of its upper-left edge to the middle of its lower-right edge; it starts past
    # the outer edge and ends just inside the face gap it meets, so its square end doesn't poke into the front face
    top, ur, ul = pt(270, R), pt(330, R), pt(210, R)
    t1 = ((ul[0] + top[0]) / 2, (ul[1] + top[1]) / 2)
    t2 = ((cx + ur[0]) / 2, (cy + ur[1]) / 2)
    dx, dy = t2[0] - t1[0], t2[1] - t1[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    d.line([(t1[0] - ux * gap, t1[1] - uy * gap), (t2[0] - ux * gap * 0.3, t2[1] - uy * gap * 0.3)],
           fill=0, width=int(gap))


img = background()
mask = Image.new("L", (W, W), 0)
d = ImageDraw.Draw(mask)
c = W / 2
box_w = R * math.sqrt(3)
bottom_y = c + R * 0.62  # two boxes side by side, one on top in the notch between them
for x in (c - box_w / 2 - STACK_GAP / 2, c + box_w / 2 + STACK_GAP / 2):
    draw_box(d, x, bottom_y)
draw_box(d, c, bottom_y - 1.5 * R - STACK_GAP)
img.paste(Image.new("RGBA", (W, W), (255, 255, 255, 255)), (0, 0), mask)
img.resize((N, N), Image.LANCZOS).save(OUT)
print("written", OUT)
