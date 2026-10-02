"""Synthesize the showreel's soundtrack -> soundtrack.wav (44.1 kHz, stereo, 30 s).

Everything is generated here — no samples. 120 BPM in F minor, built around the
picture: a ticking, uneasy intro under the problem; a riser and a beat of
silence before the logo drop at 6.0; a four-on-the-floor groove under the
features; a breakdown for the install (the clicks and chimes become the
rhythm); a hit on every montage cut; and a resolve to A-flat major on the end
card. The hits, whooshes and UI clicks are placed on the same times the
animation uses in showreel.html.
"""
import os
import wave

import numpy as np
from scipy.signal import butter, sosfilt, sawtooth

SR = 44100
DUR = 30.0
N = int(SR * DUR)
RNG = np.random.default_rng(7)
HERE = os.path.dirname(os.path.abspath(__file__))


def bus():
    return np.zeros((2, N))


DRUMS, BASS, MUSIC, FX = bus(), bus(), bus(), bus()


def T(dur):
    return np.arange(int(dur * SR)) / SR


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def filt(x, kind, f, order=2):
    sos = butter(order, f, btype=kind, fs=SR, output="sos")
    return sosfilt(sos, x)


def add(b, start, sig, pan=0.0, gain=1.0):
    """Mix a mono or stereo signal into bus b at time `start`, equal-power pan."""
    i = int(round(start * SR))
    if sig.ndim == 1:
        a = (pan + 1) * np.pi / 4
        sig = np.vstack([sig * np.cos(a), sig * np.sin(a)]) * np.sqrt(2)
    if i < 0:
        sig = sig[:, -i:]
        i = 0
    n = min(sig.shape[1], N - i)
    if n > 0:
        b[:, i:i + n] += sig[:, :n] * gain


def noise(dur):
    return RNG.standard_normal(int(dur * SR))


def env_ad(t, a, d):
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) * d)


# ---------------------------------------------------------------- instruments
def kick(drive=1.6):
    t = T(.5)
    f = 46 + 120 * np.exp(-t * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = filt(noise(.5), "highpass", 2000) * np.exp(-t * 350) * .25
    return np.tanh((body + click) * drive) / np.tanh(drive)


def clap():
    t = T(.35)
    n = filt(noise(.35), "bandpass", [900, 3200])
    e = np.zeros_like(t)
    for k, o in enumerate([0, .011, .022]):
        e += (t >= o) * np.exp(-(t - o).clip(0) * (140 if k < 2 else 20))
    return n * e * .6


def hat(open_=False):
    d = .26 if open_ else .05
    t = T(d)
    return filt(noise(d), "highpass", 7500) * np.exp(-t * (14 if open_ else 70))


def snare():
    t = T(.22)
    return filt(noise(.22), "bandpass", [1500, 6500]) * np.exp(-t * 24) * .7 + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 32) * .5


def crash(dur=2.2, bright=1.0):
    t = T(dur)
    return filt(noise(dur), "highpass", 2800 + 2000 * bright) * np.exp(-t * 2.2) * .5


def impact(dur=2.6):
    t = T(dur)
    f = 30 + 34 * np.exp(-t * 3)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6)
    boom = filt(noise(dur), "lowpass", 160) * np.exp(-t * 4) * 2.2
    slap = filt(noise(dur), "bandpass", [400, 3000]) * np.exp(-t * 26) * .7
    return np.tanh((sub + boom + slap) * 1.4)


def stamp_hit():
    t = T(.6)
    f = 70 + 90 * np.exp(-t * 25)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    slap = filt(noise(.6), "bandpass", [300, 2200]) * np.exp(-t * 22) * .9
    return np.tanh((body + slap) * 2.2) * .8


def riser(dur, f0=180, f1=1400):
    """Noise through a rising one-pole low-pass, plus a pitched sweep."""
    n = noise(dur)
    t = T(dur)
    cut = f0 * (f1 / f0) ** (t / dur) * 6
    a = np.exp(-2 * np.pi * cut / SR)
    y = np.zeros_like(n)
    s = 0.0
    for i in range(len(n)):
        s = a[i] * s + (1 - a[i]) * n[i]
        y[i] = s
    tone = np.sin(2 * np.pi * np.cumsum(f0 * (f1 / f0) ** (t / dur)) / SR) * .25 * (1 + .5 * np.sin(2 * np.pi * (6 + 18 * t / dur) * t))
    e = (t / dur) ** 2.2
    return (y * 2.2 + tone) * e


def whoosh(dur=.45, f0=500, f1=4000, up=True):
    n = noise(dur)
    t = T(dur)
    x = t / dur
    sweep = (f0 * (f1 / f0) ** x) if up else (f1 * (f0 / f1) ** x)
    a = np.exp(-2 * np.pi * sweep / SR)
    y = np.zeros_like(n)
    s = 0.0
    for i in range(len(n)):
        s = a[i] * s + (1 - a[i]) * n[i]
        y[i] = s
    y = y - filt(y, "lowpass", 180)
    e = np.sin(np.pi * x) ** 1.6
    l, r = y * e * np.cos(x * np.pi / 2), y * e * np.sin(x * np.pi / 2)
    return np.vstack([l, r]) * 1.6


def click():
    t = T(.03)
    return (np.sin(2 * np.pi * 2600 * t) * np.exp(-t * 260) + filt(noise(.03), "highpass", 4000) * np.exp(-t * 500) * .5) * .6


def tick(f=3200):
    t = T(.02)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 400) * .5


def blip(f):
    t = T(.06)
    sq = np.sign(np.sin(2 * np.pi * f * t * (1 + 2 * t)))
    return np.round(sq * 6) / 6 * np.exp(-t * 45) * .25


def chime(m, dur=1.6):
    t = T(dur)
    f = hz(m)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * 2.2 * np.exp(-t * 5)
    return (np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 3) + .35 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 6)) * .45


def pop(f=600):
    t = T(.12)
    ff = f * (1 + 1.5 * np.exp(-t * 60))
    return np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.exp(-t * 30) * .6


def snap():
    t = T(.35)
    thump = np.sin(2 * np.pi * np.cumsum(60 + 140 * np.exp(-t * 40)) / SR) * np.exp(-t * 18)
    ring = (np.sin(2 * np.pi * 1870 * t) + np.sin(2 * np.pi * 2730 * t)) * np.exp(-t * 30) * .25
    c = click()
    return np.tanh((thump + ring) * 1.5) * .9 + np.pad(c, (0, len(t) - len(c)))


def pluck(m, dur=.42, bright=1.0):
    t = T(dur)
    f = hz(m)
    y = np.zeros_like(t)
    for k in range(1, 14):
        if f * k > 12000:
            break
        y += np.sin(2 * np.pi * f * k * t) / k * np.exp(-t * (5 + 3.2 * k / bright))
    return y * np.minimum(1, t / .002) * .5


def saw_note(m, dur, detune=0.0):
    t = T(dur)
    return sawtooth(2 * np.pi * hz(m) * (1 + detune) * t + RNG.random() * 6.28)


def pad_chord(notes, dur, cutoff=1400, attack=.35, release=.6):
    t = T(dur)
    st = np.zeros((2, len(t)))
    for m in notes:
        for d, p in [(-.007, -.7), (-.003, -.3), (0, 0), (.003, .3), (.007, .7)]:
            s = saw_note(m, dur, d)
            a = (p + 1) * np.pi / 4
            st[0] += s * np.cos(a)
            st[1] += s * np.sin(a)
    st = np.vstack([filt(st[0], "lowpass", cutoff), filt(st[1], "lowpass", cutoff)])
    e = np.minimum(1, t / attack) * np.minimum(1, (dur - t) / release).clip(0)
    return st * e / (len(notes) * 5) * 1.4


def bass_note(m, dur=.22):
    t = T(dur)
    s = sawtooth(2 * np.pi * hz(m) * t)
    s = filt(s, "lowpass", 380) * 1.2 + np.sin(2 * np.pi * hz(m - 12) * t) * .9
    return np.tanh(s * 1.4) * env_ad(t, .004, 9)


# ------------------------------------------------------------------- harmony
CH = {"Fm": [53, 56, 60], "Db": [49, 53, 56], "Ab": [56, 60, 63], "Eb": [51, 55, 58]}
ROOT = {"Fm": 41, "Db": 37, "Ab": 44, "Eb": 39}


def chord_at(t):
    if t < 6:
        return "Fm"
    if t < 20:
        return ["Fm", "Db", "Ab", "Eb"][int((t - 6) // 2) % 4]
    if t < 22:
        return "Db"
    if t < 24:
        return "Eb"
    if t < 25:
        return "Fm"
    if t < 26:
        return "Eb"
    if t < 27:
        return "Db"
    if t < 28:
        return "Eb"
    return "Ab"


SEGMENTS = [(0, 6), (6, 8), (8, 10), (10, 12), (12, 14), (14, 16), (16, 18), (18, 20), (20, 22), (22, 24),
            (24, 25), (25, 26), (26, 27), (27, 28), (28, 30)]

# ------------------------------------------------------------------- arrange
KICKS = []

# Intro: dark pad, a clock of hats, a pulse that tightens.
add(MUSIC, 0, pad_chord([41, 53, 56, 60], 6.05, cutoff=520, attack=1.6, release=.25), gain=.55)
for k in range(12):
    add(DRUMS, k * .5 + .25, hat(), pan=.3 * (-1) ** k, gain=.22)
    add(DRUMS, k * .5, tick(2400), pan=-.2, gain=.25 if k % 2 == 0 else .12)
for k in range(4, 10):
    add(DRUMS, k * .5, kick(1.2), gain=.38)
    KICKS.append(k * .5)
for i, tw in enumerate([.12, .19, .55, .62, .69]):
    add(FX, tw, tick(3600 - i * 200), pan=-.4 + .2 * i, gain=.5)
add(FX, 1.22, chime(84, 1.0), gain=.35)
add(FX, 1.42, whoosh(.6, 300, 5000), gain=.7)
add(DRUMS, 2.0, kick(2.0), gain=.6)
for k in range(8):
    add(FX, 2.1 + k * .235, blip(300 + RNG.random() * 1500), pan=RNG.uniform(-.7, .7), gain=.8)
for i in range(10):
    add(FX, 2.32 + i * .055, tick(3000), pan=-.5 + i * .1, gain=.2)
for i, ts in enumerate([4.0, 4.5, 5.0]):
    add(DRUMS, ts, stamp_hit(), gain=1.0)
    add(FX, ts, crash(.8, .4), pan=(i - 1) * .5, gain=.35)
# the build: snare roll, reverse cymbal, riser, then one beat of silence
roll_t = 5.0
step = .125
while roll_t < 5.86:
    add(DRUMS, roll_t, snare(), pan=RNG.uniform(-.2, .2), gain=.25 + .55 * (roll_t - 5.0) / .86)
    roll_t += step
    step = max(.035, step * .86)
rc = crash(1.0)[::-1]
add(FX, 4.92, rc, gain=.6)
add(FX, 4.58, riser(1.32, 160, 1800), gain=.6)
add(FX, 5.5, whoosh(.35, 4000, 400, up=False), gain=.5)

# DROP
add(DRUMS, 6.0, impact(), gain=1.25)
add(FX, 6.0, crash(2.4), gain=.7)
for i in range(9):
    add(FX, 6.1 + i * .052, click(), pan=-.6 + i * .15, gain=.55)
add(FX, 6.62, whoosh(.4, 800, 6000), gain=.35)
add(FX, 7.58, whoosh(.62, 250, 7000), gain=1.0)


def groove(t0, t1, kick_on=True, clap_on=True, hats_on=True, bass_on=True, arp_on=True, arp_bright=1.0, kick_gain=.95):
    k = 0
    t = t0
    while t < t1 - 1e-6:
        beat = int(round((t - t0) / .5))
        if kick_on:
            add(DRUMS, t, kick(), gain=kick_gain)
            KICKS.append(t)
        if clap_on and beat % 2 == 1:
            add(DRUMS, t, clap(), gain=.75)
        if hats_on:
            add(DRUMS, t + .25, hat(True), pan=.25, gain=.32)
            add(DRUMS, t + .125, hat(), pan=-.3, gain=.14)
            add(DRUMS, t + .375, hat(), pan=.3, gain=.14)
        if bass_on:
            add(BASS, t + .25, bass_note(ROOT[chord_at(t + .25)]), gain=.8)
        t += .5
    if arp_on:
        t = t0
        i = 0
        while t < t1 - 1e-6:
            c = CH[chord_at(t)]
            pat = [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24, c[2] + 12, c[1] + 12, c[0] + 24, c[1] + 24]
            add(MUSIC, t, pluck(pat[i % 8], bright=arp_bright), pan=.45 * np.sin(i * .9), gain=.42)
            t += .125
            i += 1


def pads(t0, t1, cutoff=1500, gain=.6):
    for a, b in SEGMENTS:
        if a >= t0 and b <= t1:
            c = chord_at(a)
            add(MUSIC, a, pad_chord([ROOT[c] + 12] + CH[c], b - a + .05, cutoff=cutoff, attack=.06, release=.12), gain=gain)


groove(6.0, 20.0)
pads(6.0, 20.0)
# events over the groove
add(FX, 8.25, pop(900), gain=.35)
for k in range(7):
    add(FX, 8.5 + k * .5, tick(2000 + k * 180), pan=.4, gain=.55)
add(FX, 11.35, chime(87, 1.0), gain=.45)
add(FX, 11.98, whoosh(.32, 600, 8000), gain=.9)
add(FX, 12.68, snap(), gain=.9)
add(FX, 14.0, crash(1.0, .6), gain=.4)
add(DRUMS, 14.0, stamp_hit(), gain=.45)
add(FX, 14.55, riser(.37, 400, 3000), gain=.45)
add(FX, 14.92, snap(), gain=.85)
add(FX, 15.0, whoosh(.3, 1500, 5000), gain=.3)
add(FX, 16.0, crash(.9, .5), gain=.35)
for ts in [16.3, 16.45, 16.6, 16.75, 16.95, 16.86, 17.0, 17.14, 17.3, 17.34, 17.46]:
    add(FX, ts, tick(4200), pan=RNG.uniform(-.3, .3), gain=.35)
add(FX, 17.22, pop(1400), gain=.35)
for k in range(8):
    add(FX, 18.0 + k * .075, pop(500 * 2 ** ([0, 2, 4, 7, 9, 12, 14, 16][k] / 12)), pan=-.6 + k * .17, gain=.5)
add(FX, 19.3, riser(.66, 300, 4000), gain=.38)
add(FX, 19.62, whoosh(.38, 400, 9000), gain=.5)

# Install: breakdown, then build back.
add(DRUMS, 20.0, impact(1.4), gain=.35)
groove(20.0, 22.0, kick_on=False, clap_on=False, bass_on=False, arp_bright=.45)
pads(20.0, 22.0, cutoff=900, gain=.7)
groove(22.0, 24.0, clap_on=False, arp_bright=.75, kick_gain=.7)
pads(22.0, 24.0, cutoff=1200, gain=.6)
for ts, note in [(20.95, 80), (21.95, 84), (23.05, 87)]:
    add(FX, ts, click(), gain=1.0)
    add(FX, ts + .02, chime(note), pan=.2, gain=.6)
add(FX, 21.05, pop(700), gain=.5)
add(FX, 21.2, whoosh(.3, 800, 5000), gain=.35)
add(FX, 22.0, pop(500), gain=.45)
add(FX, 22.6, click(), gain=.9)
add(FX, 22.62, tick(1800), gain=.4)
for m in [68, 72, 75, 80]:
    add(FX, 23.08, chime(m, 1.4), gain=.22)
roll_t, step = 23.0, .125
while roll_t < 23.88:
    add(DRUMS, roll_t, snare(), gain=.2 + .5 * (roll_t - 23.0) / .88)
    roll_t += step
    step = max(.04, step * .88)
add(FX, 22.8, riser(1.12, 250, 2600), gain=.5)

# Montage: a hit on every cut.
groove(24.0, 26.0)
pads(24.0, 26.0, cutoff=1800)
for ts in [24.0, 24.5, 25.0, 25.5]:
    add(FX, ts, crash(.6, .8), gain=.3)
    add(FX, ts, click(), gain=.8)
    add(FX, ts + .03, click(), gain=.5)
add(FX, 24.0, crash(1.6), gain=.5)
add(FX, 25.72, whoosh(.3, 8000, 300, up=False), gain=.7)

# End card: the last hit, a lift, and a resolve to A-flat major.
add(DRUMS, 26.0, impact(3.0), gain=1.2)
add(FX, 26.0, crash(2.6), gain=.7)
groove(26.0, 28.0, clap_on=False, kick_gain=.75)
add(MUSIC, 26.0, pad_chord([37, 49, 53, 56, 60, 63], 1.0, cutoff=2200, attack=.02, release=.1), gain=.8)
add(MUSIC, 27.0, pad_chord([39, 51, 55, 58, 62], 1.0, cutoff=2200, attack=.02, release=.1), gain=.8)
add(MUSIC, 28.0, pad_chord([32, 44, 56, 60, 63, 67], 2.0, cutoff=2600, attack=.01, release=1.4), gain=1.0)
add(DRUMS, 28.0, impact(2.0), gain=.8)
add(DRUMS, 28.0, kick(), gain=.9)
KICKS.append(28.0)
for i, m in enumerate([80, 84, 87, 92]):
    add(FX, 28.0 + i * .06, chime(m, 1.8), pan=-.3 + .2 * i, gain=.4)
add(FX, 27.98, whoosh(.75, 1200, 9000), gain=.35)
for ts in [28.55, 29.05]:
    add(FX, ts, tick(2600), gain=.25)


# --------------------------------------------------------------------- mix
def reverb(x, rt=1.7, damp=5000):
    n = int(rt * SR)
    t = np.arange(n) / SR
    out = []
    for ch in range(2):
        ir = RNG.standard_normal(n) * np.exp(-6.9 * t / rt)
        ir = filt(ir, "lowpass", damp)
        ir[:int(.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        L = len(x[ch]) + n
        size = 1 << (L - 1).bit_length()
        y = np.fft.irfft(np.fft.rfft(x[ch], size) * np.fft.rfft(ir, size), size)[:len(x[ch])]
        out.append(y)
    return np.vstack(out)


# Sidechain: the music breathes with the kick.
duck = np.ones(N)
tt = np.arange(N) / SR
for k in KICKS:
    i = int(k * SR)
    seg = tt[i:i + int(.35 * SR)] - k
    duck[i:i + len(seg)] = np.minimum(duck[i:i + len(seg)], 1 - .55 * np.exp(-seg * 9))
MUSIC *= duck
BASS *= duck

wet = reverb(MUSIC * .35 + FX * .4 + DRUMS * .08)
mix = DRUMS * .9 + BASS * .85 + MUSIC * .8 + FX * .9 + wet * .55
mix = np.vstack([filt(mix[0], "highpass", 28), filt(mix[1], "highpass", 28)])
# Tame the air: the noise-built hats, crashes and risers pile up above 8 kHz.
mix = mix - .5 * np.vstack([filt(mix[0], "highpass", 8000), filt(mix[1], "highpass", 8000)])
# Fade the tail and the very first frames.
fade = np.ones(N)
fade[-int(1.0 * SR):] = np.linspace(1, 0, int(1.0 * SR)) ** 1.5
fade[:int(.01 * SR)] = np.linspace(0, 1, int(.01 * SR))
mix *= fade
# One beat of near-silence before the drop: the room sucks in, then the logo hits.
gate = np.ones(N)
a, b = int(5.93 * SR), int(6.0 * SR)
gate[a - int(.012 * SR):a] = np.linspace(1, .03, int(.012 * SR))
gate[a:b] = .03
mix *= gate
# Gentle glue: soft clip, then normalize to -1 dBFS.
mix = mix / np.max(np.abs(mix)) * 1.6
mix = np.tanh(mix)
mix = mix / np.max(np.abs(mix)) * 10 ** (-1 / 20)

pcm = (mix.T * 32767).astype(np.int16)
out = os.path.join(HERE, "soundtrack.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(out, f"{N / SR:.1f}s")
