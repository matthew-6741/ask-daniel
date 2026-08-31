#!/usr/bin/env python3
"""Render the DiagnostechAI promo video (720x1280 @ 30fps, ~23s, H.264 MP4)."""

import math
import imageio
from PIL import Image, ImageDraw, ImageFont

W, H   = 720, 1280
FPS    = 30
OUT    = "/Users/sanchez/Desktop/DiagnostechAI-promo.mp4"

CREAM     = (244, 242, 236)
WHITE     = (255, 255, 255)
INK       = (26, 26, 24)
MUTED     = (122, 122, 114)
TERRA     = (192, 57, 43)
TERRA_DK  = (169, 50, 38)
TERRA_BG  = (250, 235, 232)
GREEN     = (39, 174, 96)
BORDER    = (228, 225, 216)

F = "/System/Library/Fonts/Supplemental/"
def font(name, size):
    return ImageFont.truetype(F + name, size)

XXL   = font("Arial Bold.ttf", 96)
XL    = font("Arial Bold.ttf", 64)
LG    = font("Arial Bold.ttf", 40)
MD    = font("Arial Bold.ttf", 30)
BODY  = font("Arial.ttf", 28)
SM    = font("Arial Bold.ttf", 24)
XS    = font("Arial.ttf", 22)
TINY  = font("Arial Bold.ttf", 19)

def ease_out(t):  return 1 - (1 - t) ** 3
def clamp(t):     return max(0.0, min(1.0, t))
def seg(t, a, b): return clamp((t - a) / (b - a))

def ctext(d, cx, y, s, f, fill, anchor="mm"):
    d.text((cx, y), s, font=f, fill=fill, anchor=anchor)

JOB = "Replace leaking P-trap under kitchen sink, 1 1/2 inch PVC"

ITEMS = [
    ("P-Trap Kit 1-1/2 in PVC",      "with slip nuts + washers", "1", "Aisle 34", "$8.47"),
    ("PVC Tailpiece 1-1/2 in",       "kitchen sink drain",       "1", "Aisle 34", "$4.28"),
    ("Slip Joint Washers 4-pack",    "1-1/2 in beveled",         "1", "Aisle 34", "$3.15"),
    ("Plumber's Tape PTFE",          "1/2 in x 260 in",          "2", "Aisle 33", "$1.98"),
    ("Channel-Lock Pliers 10 in",    "if not owned",             "1", "Aisle 17", "$12.98"),
]

def rr(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)

def draw_logo(d, cx, cy, size, alpha_img=None):
    half = size // 2
    rr(d, (cx-half, cy-half, cx+half, cy+half), int(size*0.27), fill=TERRA)
    f = font("Arial Bold.ttf", int(size*0.42))
    ctext(d, cx, cy+1, "DA", f, WHITE)

def scene_hook(d, t):
    # "TWO TRIPS?" slams in, strike-through, then "ONE."
    p1 = ease_out(seg(t, 0.0, 0.45))
    if p1 > 0:
        s = 1.6 - 0.6 * p1
        f = font("Arial Bold.ttf", max(10, int(96 * s)))
        col = tuple(int(c + (INK[i]-c)*p1) for i, c in enumerate(CREAM))
        ctext(d, W//2, 480, "TWO TRIPS?", f, col)
    p2 = ease_out(seg(t, 0.9, 1.5))
    if p2 > 0:
        bbox = d.textbbox((W//2, 480), "TWO TRIPS?", font=XXL, anchor="mm")
        x0, x1 = bbox[0]-14, bbox[2]+14
        xe = x0 + (x1-x0) * p2
        d.line((x0, 478, xe, 478), fill=TERRA, width=14)
    p3 = ease_out(seg(t, 1.7, 2.3))
    if p3 > 0:
        y = 660 - 40*(1-p3)
        f = font("Arial Bold.ttf", 150)
        ctext(d, W//2, y, "ONE.", f, TERRA)

def draw_app_frame(d):
    rr(d, (40, 120, W-40, H-120), 36, fill=WHITE, outline=BORDER, width=2)
    draw_logo(d, 105, 195, 62)
    d.text((150, 172), "DIAGNOSTECHAI", font=MD, fill=INK)
    d.text((150, 206), "One-trip material list", font=XS, fill=MUTED)
    d.line((70, 250, W-70, 250), fill=BORDER, width=2)

def scene_typing(d, t):
    draw_app_frame(d)
    d.text((70, 285), "Describe the job", font=SM, fill=INK)
    rr(d, (70, 330, W-70, 560), 20, fill=CREAM, outline=BORDER, width=2)
    n = int(len(JOB) * seg(t, 0.2, 4.4))
    shown = JOB[:n]
    # wrap
    words, lines, cur = shown.split(" "), [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if d.textlength(trial, font=BODY) < W - 190:
            cur = trial
        else:
            lines.append(cur); cur = w_
    lines.append(cur)
    y = 360
    for ln in lines:
        d.text((100, y), ln, font=BODY, fill=INK)
        y += 40
    if (t * 2) % 1 < 0.5 and n < len(JOB):
        cw = d.textlength(lines[-1], font=BODY)
        d.rectangle((100+cw+6, y-40, 100+cw+10, y-8), fill=TERRA)
    # button
    pb = seg(t, 4.6, 5.0)
    if pb > 0:
        pressed = t > 5.35
        col = TERRA_DK if pressed else TERRA
        off = 3 if pressed else 0
        rr(d, (70, 610+off, W-70, 692+off), 20, fill=col)
        ctext(d, W//2, 651+off, "Build my material list", LG, WHITE)

def scene_loading(d, t):
    draw_app_frame(d)
    steps = ["Reading the job", "Matching store inventory", "Building your list"]
    ctext(d, W//2, 320, "Working on it...", LG, INK)
    for i, s in enumerate(steps):
        start = 0.15 + i * 0.55
        p = seg(t, start, start + 0.3)
        if p <= 0:
            continue
        y = 420 + i * 92
        done = t > start + 0.65
        rr(d, (90, y, W-90, y+72), 16, fill=CREAM)
        cx, cy = 135, y + 36
        if done:
            d.ellipse((cx-17, cy-17, cx+17, cy+17), fill=GREEN)
            d.line((cx-8, cy, cx-2, cy+7), fill=WHITE, width=4)
            d.line((cx-2, cy+7, cx+9, cy-6), fill=WHITE, width=4)
        else:
            a = (t * 6) % (2*math.pi)
            d.arc((cx-15, cy-15, cx+15, cy+15), math.degrees(a), math.degrees(a)+270, fill=TERRA, width=5)
        d.text((175, y+22), s, font=BODY, fill=INK if done else MUTED)

def scene_results(d, t, pulse=False):
    draw_app_frame(d)
    d.text((70, 280), "Your one-trip list", font=LG, fill=INK)
    d.text((70, 330), "Home Depot  -  5 items", font=XS, fill=MUTED)
    y0 = 385
    for i, (name, spec, qty, aisle, price) in enumerate(ITEMS):
        p = ease_out(seg(t, 0.15 + i*0.35, 0.55 + i*0.35))
        if p <= 0:
            continue
        y = y0 + i * 122 + int(30 * (1-p))
        rr(d, (70, y, W-70, y+106), 18, fill=WHITE, outline=BORDER, width=2)
        d.text((95, y+16), name, font=SM, fill=INK)
        d.text((95, y+50), spec, font=XS, fill=MUTED)
        # qty badge
        rr(d, (95, y+76, 150, y+99), 11, fill=CREAM)
        ctext(d, 122, y+88, "x " + qty, TINY, MUTED)
        # aisle badge — the money shot
        glow = 1.0
        if pulse:
            glow = 1.0 + 0.12 * math.sin(t * 5 + i)
        bw, bh = int(118 * glow), int(40 * glow)
        bx, by = 458, y + 62
        rr(d, (bx - (bw-118)//2, by - (bh-40)//2, bx + bw - (bw-118)//2, by + bh - (bh-40)//2),
           bh//2, fill=TERRA_BG)
        ctext(d, bx + 59, by + 20, aisle, TINY, TERRA)
        d.text((W-95, y+22), price, font=SM, fill=INK, anchor="ra")
    pt = seg(t, 2.1, 2.5)
    if pt > 0:
        y = y0 + 5*122 + 8
        d.line((70, y, W-70, y), fill=BORDER, width=2)
        d.text((70, y+18), "Estimated total", font=SM, fill=MUTED)
        total = 30.86 * ease_out(pt)
        d.text((W-70, y+18), f"${total:.2f}", font=LG, fill=TERRA, anchor="ra")

def scene_aisle_banner(d, t):
    scene_results(d, 3.0, pulse=True)
    p = ease_out(seg(t, 0.0, 0.4))
    bh = 150
    y = H//2 - bh//2
    xoff = int((1-p) * W)
    d.rectangle((xoff, y, xoff+W, y+bh), fill=TERRA)
    ctext(d, xoff + W//2, y+52, "EXACT AISLE NUMBERS", font("Arial Bold.ttf", 52), WHITE)
    ctext(d, xoff + W//2, y+107, "One trip. Zero returns.", MD, (255, 214, 206))

def scene_outro(d, t):
    p1 = ease_out(seg(t, 0.0, 0.5))
    if p1 > 0:
        draw_logo(d, W//2, 480 - int(20*(1-p1)), int(150*p1) or 1)
    p2 = ease_out(seg(t, 0.4, 0.9))
    if p2 > 0:
        ctext(d, W//2, 630, "DiagnostechAI", font("Arial Bold.ttf", 58), INK)
    p3 = ease_out(seg(t, 0.8, 1.3))
    if p3 > 0:
        ctext(d, W//2, 700, "One trip. Done.", LG, TERRA)
    p4 = ease_out(seg(t, 1.4, 1.9))
    if p4 > 0:
        rr(d, (W//2-190, 780, W//2+190, 842), 31, outline=TERRA, width=3)
        ctext(d, W//2, 811, "Beta access - link in bio", SM, TERRA)

# ── Timeline: (duration, render_fn) ──
TIMELINE = [
    (2.8, scene_hook),
    (5.8, scene_typing),
    (2.2, scene_loading),
    (4.6, scene_results),
    (3.2, scene_aisle_banner),
    (3.8, scene_outro),
]

def crossfade(img_a, img_b, p):
    return Image.blend(img_a, img_b, p)

def render_frame(t_global):
    acc = 0.0
    for dur, fn in TIMELINE:
        if t_global < acc + dur:
            img = Image.new("RGB", (W, H), CREAM)
            fn(ImageDraw.Draw(img), t_global - acc)
            # fade-in first 0.25s of each scene (except first)
            local = t_global - acc
            if acc > 0 and local < 0.25:
                prev = Image.new("RGB", (W, H), CREAM)
                img = crossfade(prev, img, local / 0.25)
            return img
        acc += dur
    img = Image.new("RGB", (W, H), CREAM)
    scene_outro(ImageDraw.Draw(img), 99)
    return img

total = sum(d for d, _ in TIMELINE)
frames = int(total * FPS)
print(f"Rendering {frames} frames ({total:.1f}s at {FPS}fps)...")

writer = imageio.get_writer(OUT, fps=FPS, codec="libx264",
                            quality=8, pixelformat="yuv420p", macro_block_size=8)
import numpy as np
for i in range(frames):
    writer.append_data(np.asarray(render_frame(i / FPS)))
    if i % 120 == 0:
        print(f"  frame {i}/{frames}")
writer.close()
print(f"Done -> {OUT}")
