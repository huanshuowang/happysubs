"""Render the film to video — the 16:9 showreel or the 9:16 vertical cut.

    python render.py stills 0.5 2.4 6.3          # PNG stills + a contact sheet, for review
    python render.py video                       # full 30 s render -> happysubs-showreel.mp4
    python render.py encode                      # re-encode already rendered frames
    python render.py patch 19.2 20.1             # re-render one stretch, then re-encode
    python render.py vertical video              # any of the above for vertical.html (9:16)
    python render.py vertical-en video           # the English 9:16 cut (vertical.html?lang=en)

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
import uuid
from multiprocessing import Process

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FPS, SUB, SHUTTER, DUR = 60, 4, 0.5, 30.0
WORKERS = 4
# Both cuts share the timeline and the soundtrack; only the page and the frame differ.
REELS = {
    "showreel": {"page": "showreel.html", "size": (1920, 1080), "out": "happysubs-showreel.mp4",
                 "frames": "frames", "stills": "stills"},
    "vertical": {"page": "vertical.html", "size": (1080, 1920), "out": "happysubs-vertical.mp4",
                 "frames": "frames-vertical", "stills": "stills-vertical"},
    "vertical-en": {"page": "vertical.html", "query": "&lang=en", "size": (1080, 1920),
                    "out": "happysubs-vertical-en.mp4", "frames": "frames-vertical-en", "stills": "stills-vertical-en"},
}
# The cut is chosen once, here, and handed to every worker as an argument —
# spawned workers re-import this module, so nothing may depend on module state.
REEL = sys.argv.pop(1) if len(sys.argv) > 1 and sys.argv[1] in REELS else "showreel"


def dirs(reel):
    r = REELS[reel]
    return os.path.join(HERE, "build", r["frames"]), os.path.join(HERE, "build", r["stills"])


def open_page(p, reel, tag=None):
    r = REELS[reel]
    # A generous launch timeout: four Chromes starting at once on a busy
    # machine have taken longer than Playwright's default to come up. The tag
    # is a no-op switch that marks this worker's Chrome so a stalled one can
    # be found and killed.
    args = ["--force-color-profile=srgb", "--hide-scrollbars"] + ([f"--happysubs-render={tag}"] if tag else [])
    browser = p.chromium.launch(channel="chrome", headless=True, timeout=300000, args=args)
    w, h = r["size"]
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    page.goto("file://" + os.path.join(HERE, r["page"]) + "?render=1" + r.get("query", ""))
    page.wait_for_function("window.__ready === true")
    return browser, page


def stills(reel, times):
    stills_dir = dirs(reel)[1]
    os.makedirs(stills_dir, exist_ok=True)
    paths = []
    with sync_playwright() as p:
        browser, page = open_page(p, reel)
        for t in times:
            page.evaluate(f"window.__seek({t})")
            path = os.path.join(stills_dir, f"t{t:06.3f}.png")
            page.screenshot(path=path)
            paths.append(path)
        browser.close()
    contact(paths, times, stills_dir, REELS[reel]["size"])


def contact(paths, times, out_dir, size=(1920, 1080)):
    from PIL import Image, ImageDraw
    portrait = size[1] > size[0]
    cols = (5 if len(paths) > 6 else 3 if len(paths) > 2 else len(paths)) if portrait else \
        (3 if len(paths) > 4 else 2 if len(paths) > 1 else 1)
    rows = (len(paths) + cols - 1) // cols
    tw, th = (300, 533) if portrait else (640, 360)
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * 8, rows * (th + 26) + 8), (40, 40, 44))
    d = ImageDraw.Draw(sheet)
    for i, (path, t) in enumerate(zip(paths, times)):
        im = Image.open(path).convert("RGB").resize((tw, th), Image.LANCZOS)
        x, y = 8 + (i % cols) * (tw + 8), 8 + (i // cols) * (th + 26)
        sheet.paste(im, (x, y))
        d.text((x + 4, y + th + 5), f"t = {t:.3f}s", fill=(230, 230, 230))
    out = os.path.join(out_dir, "contact.png")
    sheet.save(out)
    print(out)


def worker(reel, frames, tag):
    frames_dir = dirs(reel)[0]
    with sync_playwright() as p:
        browser, page = open_page(p, reel, tag)
        for f in frames:
            for k in range(SUB):
                t = min(DUR - 1e-3, (f + k * SHUTTER / SUB) / FPS)
                page.evaluate(f"window.__seek({t})")
                page.screenshot(path=os.path.join(frames_dir, f"{f * SUB + k:06d}.jpg"),
                                type="jpeg", quality=94)
        # Every frame is on disk. Closing the browser or leaving
        # sync_playwright() can hang on driver shutdown, so leave now: the
        # driver and Chrome go with the pipe, and the watchdog's pkill catches
        # anything that lingers.
        os._exit(0)


def render_frames(reel, frames, stall=150, attempts=3):
    """Render frames across WORKERS Chromes, with a watchdog.

    A page.evaluate() on a renderer that has stopped responding waits forever,
    and it has happened: one worker sat at 0% CPU with its share unrendered
    while the others finished. So a worker that writes nothing new for
    `stall` seconds is killed along with its Chrome, and whatever is still
    missing is handed out again."""
    frames_dir = dirs(reel)[0]
    done = lambda f: all(os.path.exists(os.path.join(frames_dir, f"{f * SUB + k:06d}.jpg")) for k in range(SUB))
    t0 = time.time()
    for attempt in range(attempts):
        todo = [f for f in frames if not done(f)]
        if not todo:
            break
        if attempt:
            print(f"retrying {len(todo)} frames")
        chunk = (len(todo) + WORKERS - 1) // WORKERS
        jobs = []
        for i in range(WORKERS):
            part = todo[i * chunk:(i + 1) * chunk]
            if part:
                tag = uuid.uuid4().hex[:12]
                pr = Process(target=worker, args=(reel, part, tag))
                pr.start()
                jobs.append({"pr": pr, "part": part, "tag": tag, "seen": -1, "since": time.time()})
        while any(j["pr"].is_alive() for j in jobs):
            time.sleep(5)
            for j in jobs:
                if not j["pr"].is_alive():
                    continue
                n = sum(done(f) for f in j["part"])
                if n == len(j["part"]) and time.time() - j["since"] > 10:
                    j["pr"].kill()          # finished, just slow to exit
                    subprocess.run(["pkill", "-f", f"happysubs-render={j['tag']}"])
                elif n != j["seen"]:
                    j["seen"], j["since"] = n, time.time()
                elif time.time() - j["since"] > stall:
                    print(f"worker {j['tag']} stalled at {n}/{len(j['part'])} frames; killing it")
                    j["pr"].kill()
                    subprocess.run(["pkill", "-f", f"happysubs-render={j['tag']}"])
    missing = [f for f in frames if not done(f)]
    if missing:
        sys.exit(f"{len(missing)} frames still missing after {attempts} attempts; rerun with `patch`.")
    print(f"rendered {len(frames) * SUB} samples in {time.time() - t0:.0f}s")


def video(reel):
    frames_dir = dirs(reel)[0]
    shutil.rmtree(frames_dir, ignore_errors=True)
    os.makedirs(frames_dir)
    render_frames(reel, list(range(int(round(DUR * FPS)))))
    encode(reel)


def encode(reel):
    frames_dir = dirs(reel)[0]
    audio = os.path.join(HERE, "soundtrack.wav")
    out = os.path.join(HERE, REELS[reel]["out"])
    vf = (f"tmix=frames={SUB}:weights='{' '.join(['1'] * SUB)}',"
          f"select='eq(mod(n\\,{SUB})\\,{SUB - 1})',setpts=N/({FPS}*TB),"
          # Screenshots are full-range RGB; video players expect limited-range BT.709.
          f"scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p")
    cmd = ["ffmpeg", "-y", "-framerate", str(FPS * SUB), "-i", os.path.join(frames_dir, "%06d.jpg")]
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
        stills(REEL, [float(x) for x in sys.argv[2:]])
    elif sys.argv[1] == "video":
        video(REEL)
    elif sys.argv[1] == "encode":
        encode(REEL)
    elif sys.argv[1] == "patch":
        # Re-render only frames between two times, then re-encode: python render.py patch 19.2 20.1
        a, b = int(float(sys.argv[2]) * FPS), min(int(float(sys.argv[3]) * FPS), int(DUR * FPS) - 1)
        os.makedirs(dirs(REEL)[0], exist_ok=True)
        render_frames(REEL, list(range(a, b + 1)))
        encode(REEL)
