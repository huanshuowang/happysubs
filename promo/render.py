"""Render showreel.html to video.

    python render.py stills 0.5 2.4 6.3          # PNG stills + a contact sheet, for review
    python render.py video                       # full 30 s render -> happysubs-showreel.mp4
    python render.py encode                      # re-encode already rendered frames
    python render.py patch 19.2 20.1             # re-render one stretch, then re-encode

The page exposes window.__seek(t); every frame is drawn from t alone, so frames
can be rendered out of order and in parallel. Motion blur comes from sampling
each output frame SUB times across a 180-degree shutter and averaging them in
ffmpeg (tmix), which blurs whatever moves — whip pans, zooms, particles — the
way a real camera would.

Needs: playwright (driving the installed Google Chrome), ffmpeg, Pillow.
"""
import os
import shutil
import subprocess
import sys
import time
from multiprocessing import Process

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "file://" + os.path.join(HERE, "showreel.html") + "?render=1"
FPS, SUB, SHUTTER, DUR = 60, 4, 0.5, 30.0
WORKERS = 4
FRAMES_DIR = os.path.join(HERE, "build", "frames")
STILLS_DIR = os.path.join(HERE, "build", "stills")


def open_page(p):
    browser = p.chromium.launch(channel="chrome", headless=True,
                                args=["--force-color-profile=srgb", "--hide-scrollbars"])
    page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    page.goto(URL)
    page.wait_for_function("window.__ready === true")
    return browser, page


def stills(times):
    os.makedirs(STILLS_DIR, exist_ok=True)
    paths = []
    with sync_playwright() as p:
        browser, page = open_page(p)
        for t in times:
            page.evaluate(f"window.__seek({t})")
            path = os.path.join(STILLS_DIR, f"t{t:06.3f}.png")
            page.screenshot(path=path)
            paths.append(path)
        browser.close()
    contact(paths, times)


def contact(paths, times):
    from PIL import Image, ImageDraw
    cols = 3 if len(paths) > 4 else 2 if len(paths) > 1 else 1
    rows = (len(paths) + cols - 1) // cols
    tw, th = 640, 360
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * 8, rows * (th + 26) + 8), (40, 40, 44))
    d = ImageDraw.Draw(sheet)
    for i, (path, t) in enumerate(zip(paths, times)):
        im = Image.open(path).convert("RGB").resize((tw, th), Image.LANCZOS)
        x, y = 8 + (i % cols) * (tw + 8), 8 + (i // cols) * (th + 26)
        sheet.paste(im, (x, y))
        d.text((x + 4, y + th + 5), f"t = {t:.3f}s", fill=(230, 230, 230))
    out = os.path.join(STILLS_DIR, "contact.png")
    sheet.save(out)
    print(out)


def worker(idx, frames):
    with sync_playwright() as p:
        browser, page = open_page(p)
        for f in frames:
            for k in range(SUB):
                t = min(DUR - 1e-3, (f + k * SHUTTER / SUB) / FPS)
                page.evaluate(f"window.__seek({t})")
                page.screenshot(path=os.path.join(FRAMES_DIR, f"{f * SUB + k:06d}.jpg"),
                                type="jpeg", quality=94)
        browser.close()
    # Leaving sync_playwright() in a spawned child can hang on driver shutdown;
    # every frame is on disk by now, so leave without waiting for it.
    os._exit(0)


def video():
    shutil.rmtree(FRAMES_DIR, ignore_errors=True)
    os.makedirs(FRAMES_DIR)
    total = int(round(DUR * FPS))
    chunk = (total + WORKERS - 1) // WORKERS
    t0 = time.time()
    procs = [Process(target=worker, args=(i, range(i * chunk, min(total, (i + 1) * chunk))))
             for i in range(WORKERS)]
    for pr in procs:
        pr.start()
    for pr in procs:
        pr.join()
    print(f"rendered {total * SUB} samples in {time.time() - t0:.0f}s")
    encode()


def encode():
    audio = os.path.join(HERE, "soundtrack.wav")
    out = os.path.join(HERE, "happysubs-showreel.mp4")
    vf = (f"tmix=frames={SUB}:weights='{' '.join(['1'] * SUB)}',"
          f"select='eq(mod(n\\,{SUB})\\,{SUB - 1})',setpts=N/({FPS}*TB),"
          # Screenshots are full-range RGB; video players expect limited-range BT.709.
          f"scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p")
    cmd = ["ffmpeg", "-y", "-framerate", str(FPS * SUB), "-i", os.path.join(FRAMES_DIR, "%06d.jpg")]
    if os.path.exists(audio):
        cmd += ["-i", audio]
    cmd += ["-vf", vf, "-r", str(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "15",
            "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-bsf:v", "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"]
    if os.path.exists(audio):
        cmd += ["-c:a", "aac", "-b:a", "320k", "-shortest"]
    cmd += [out]
    subprocess.run(cmd, check=True)
    print(out)


if __name__ == "__main__":
    if sys.argv[1] == "stills":
        stills([float(x) for x in sys.argv[2:]])
    elif sys.argv[1] == "video":
        video()
    elif sys.argv[1] == "encode":
        encode()
    elif sys.argv[1] == "patch":
        # Re-render only frames between two times, then re-encode: python render.py patch 19.2 20.1
        a, b = int(float(sys.argv[2]) * FPS), int(float(sys.argv[3]) * FPS)
        frames = list(range(a, b + 1))
        chunk = (len(frames) + WORKERS - 1) // WORKERS
        procs = [Process(target=worker, args=(i, frames[i * chunk:(i + 1) * chunk])) for i in range(WORKERS)]
        for pr in procs:
            pr.start()
        for pr in procs:
            pr.join()
        encode()
