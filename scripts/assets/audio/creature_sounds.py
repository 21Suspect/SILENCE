"""Designs the Listener's voice and the noises it makes, as audio files.

    python creature_sounds.py            (needs numpy, scipy and ffmpeg)

Writes public/audio/creature/<sound>_<variant>.mp3, mono: the game places them in 3D.
Nothing here is a plain oscillator beep. The voice is a source-filter model, the way an animal's
is: an irregular glottal pulse train (jitter, shimmer, period doubling, breath noise) driven
through moving throat resonances, overdriven, then set in a forest with a reverb tail. The
cracks are struck wood modes. Two variants are cut from the reveal recording the game ships.
"""
import os
import subprocess
import sys
import tempfile

import numpy as np
from scipy import signal

SR = 44100
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(ROOT, "public/audio/creature")
REVEAL = os.path.join(ROOT, "public/audio/scary sound.mp3")
rng = np.random.default_rng(7741)


# ----------------------------------------------------------------------------- helpers
def t_axis(seconds):
    return np.arange(int(seconds * SR)) / SR


def curve(points, seconds, kind="linear"):
    """Breakpoint envelope: [(time fraction, value), ...] over `seconds`."""
    n = int(seconds * SR)
    x = np.array([p[0] for p in points]) * (n - 1)
    y = np.array([p[1] for p in points], float)
    out = np.interp(np.arange(n), x, np.log(y) if kind == "exp" else y)
    return np.exp(out) if kind == "exp" else out


def smooth_noise(n, cutoff, seed=None):
    """Band-limited random wander in -1..1: the unsteadiness of a living thing."""
    r = np.random.default_rng(seed) if seed is not None else rng
    b, a = signal.butter(2, cutoff / (SR / 2))
    x = signal.lfilter(b, a, r.standard_normal(n + SR))[SR:]
    return x / (np.abs(x).max() + 1e-9)


def band(x, lo, hi, order=2):
    sos = signal.butter(order, [lo / (SR / 2), min(hi, SR / 2 - 200) / (SR / 2)], "bandpass", output="sos")
    return signal.sosfilt(sos, x)


def lowpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f / (SR / 2), output="sos"), x)


def highpass(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f / (SR / 2), "highpass", output="sos"), x)


def resonate(x, freqs, qs, gains, block=256):
    """Parallel resonators whose centre frequencies move: `freqs` are arrays over time."""
    out = np.zeros_like(x)
    for f, q, g in zip(freqs, qs, gains):
        f = np.broadcast_to(np.asarray(f, float), x.shape)
        zi = np.zeros(2)
        y = np.empty_like(x)
        for i in range(0, len(x), block):
            fc = float(np.clip(f[i], 40, SR / 2 - 400))
            b, a = signal.iirpeak(fc / (SR / 2), q)
            y[i:i + block], zi = signal.lfilter(b, a, x[i:i + block], zi=zi)
        out += y * g
    return out


def drive(x, amount):
    return np.tanh(x * amount) / np.tanh(amount)


def forest(x, wet=.25, seconds=1.6, damp=3500, seed=3):
    """A reverb of trunks and open air: sparse early slaps, then a dull, quick-dying tail."""
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    tail = r.standard_normal(n) * np.exp(-np.arange(n) / (SR * seconds / 6.9))
    tail = lowpass(tail, damp)
    tail[: int(.012 * SR)] = 0
    for _ in range(9):
        k = int(r.uniform(.02, .16) * SR)
        tail[k] += r.uniform(.5, 1.4) * r.choice((-1, 1))
    tail /= np.sqrt((tail ** 2).sum())
    y = signal.fftconvolve(x, tail)
    dry = np.concatenate([x, np.zeros(len(y) - len(x))])
    return dry * (1 - wet * .5) + y * wet * 2.2


def far(x, metres):
    """Air and trees take the top off and smear the attack."""
    cutoff = float(np.clip(9000 / (1 + metres / 14), 700, 9000))
    return forest(lowpass(x, cutoff, 2), wet=min(.75, .2 + metres / 90), seconds=2.4, damp=cutoff, seed=11)


def finish(x, peak=.89, fade_in=.004, fade_out=.06):
    x = x - x.mean()
    a, b = int(fade_in * SR), int(fade_out * SR)
    x[:a] *= np.linspace(0, 1, a)
    x[-b:] *= np.linspace(1, 0, b) ** 2
    return x / (np.abs(x).max() + 1e-9) * peak


# ----------------------------------------------------------------------------- the voice
def glottis(f0, roughness, doubling, breath, seed):
    """An irregular pulse train. f0, roughness (0..1 jitter and shimmer), doubling (0..1 period doubling:
    the broken, two-toned quality of a scream) and breath (0..1) are arrays over time."""
    n = len(f0)
    wander = smooth_noise(n, 35, seed) * .5 + smooth_noise(n, 400, seed + 1) * .5
    f = f0 * (1 + wander * .09 * roughness)
    phase = np.cumsum(f) / SR
    cycle = phase % 1.0
    # Open phase rises slowly and shuts fast: that asymmetry is where the buzz of a throat comes from.
    pulse = np.where(cycle < .62, np.sin(np.pi * cycle / .62) ** 2, 0.0) - .31
    flow = np.diff(pulse, prepend=pulse[0]) * 18
    # Period doubling: every other cycle is weaker and late, which drops a rough tone an octave below.
    odd = (np.floor(phase) % 2).astype(float)
    flow *= 1 - doubling * odd * .85
    shimmer = 1 + smooth_noise(n, 60, seed + 2) * .45 * roughness
    air = highpass(np.random.default_rng(seed + 3).standard_normal(n), 900) * (.35 + .65 * (cycle < .62))
    return flow * shimmer + air * breath * .55


def voice(seconds, pitch, formants, roughness=.5, doubling=0.0, breath=.2, gain=None, drive_amount=3.0, seed=1, qs=(7, 9, 10, 9)):
    n = int(seconds * SR)
    arr = lambda v: v if isinstance(v, np.ndarray) else np.full(n, float(v))
    src = glottis(arr(pitch), arr(roughness), arr(doubling), arr(breath), seed)
    y = resonate(src, [arr(f) for f in formants], qs[: len(formants)], [1.0, .8, .55, .4][: len(formants)])
    # Nothing in a throat sounds below its own pitch (bar the octave drop of a broken voice): clear the rumble out.
    y = highpass(y, max(30.0, float(np.min(arr(pitch))) * .42), 2)
    floor = max(30.0, float(np.min(arr(pitch))) * .42)
    y = y / (np.abs(y).max() + 1e-9)
    if gain is not None:
        y *= gain
    # Overdrive under a moving envelope leaves a slow thump behind; take that out as well.
    return highpass(drive(y, drive_amount), floor, 2)


def reveal_excerpt(start, seconds):
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "r.f32")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(seconds), "-i", REVEAL, "-ac", "1", "-ar", str(SR), "-f", "f32le", raw], check=True)
        return np.fromfile(raw, np.float32).astype(float)


# ----------------------------------------------------------------------------- variation
class Take:
    """One performance of a sound. The same animal never makes the same noise twice: each take nudges
    pitch, timing and length a little, from its own seed."""

    def __init__(self, seed):
        self.r = np.random.default_rng(seed)
        self.seed = seed

    def around(self, value, spread):
        return value * float(self.r.uniform(1 - spread, 1 + spread))

    def bend(self, points, spread, time_spread=.0):
        """A breakpoint curve with every value (and optionally inner times) nudged."""
        out = []
        for i, (t, v) in enumerate(points):
            inner = 0 < i < len(points) - 1
            out.append((float(np.clip(t + (self.r.uniform(-time_spread, time_spread) if inner else 0), 0, 1)), v * float(self.r.uniform(1 - spread, 1 + spread))))
        out.sort(key=lambda p: p[0])
        return out


# ----------------------------------------------------------------------------- the roar
def screech(take):
    """Roar under a scream: a big chest and a small throat at once. (The one that was chosen.)"""
    k = take
    d = k.around(2.4, .14)
    low_pitch = curve(k.bend([(0, 78), (.12, 118), (.6, 132), (1, 70)], .07, .04), d, "exp")
    low = voice(d, low_pitch, [curve(k.bend([(0, 420), (.3, 640), (1, 380)], .06), d), curve(k.bend([(0, 1050), (.3, 1500), (1, 900)], .06), d), k.around(2500.0, .05)], roughness=1.0,
                doubling=curve([(0, .6), (.4, 1), (1, .8)], d), breath=.5, drive_amount=7, seed=k.seed * 10 + 1, qs=(5, 6, 7))
    high_pitch = curve(k.bend([(0, 610), (.1, 1040), (.45, 1160), (.75, 1010), (1, 520)], .08, .05), d, "exp")
    break_at = k.around(.36, .25)                               # where the scream tears into two tones
    high = voice(d, high_pitch, [k.around(1500.0, .05), curve(k.bend([(0, 2600), (.3, 3400), (1, 2300)], .06), d), k.around(5200.0, .05)],
                 roughness=curve([(0, .3), (.4, 1), (1, 1)], d), doubling=curve([(0, 0), (break_at - .04, 0), (break_at + .04, 1), (1, 1)], d), breath=.35, drive_amount=5, seed=k.seed * 10 + 2)
    env = curve([(0, .02), (.05, 1), (k.around(.7, .1), .9), (1, 0)], d)
    y = (low * .9 + high * curve([(0, .2), (.15, 1), (.8, .8), (1, 0)], d) * k.around(.75, .15)) * env
    return finish(forest(drive(y, 2.2), wet=.2, seed=k.seed))


# ----------------------------------------------------------------------------- hiss, rattle, clicks
def clicks(seconds, rate, seed, sharp=1.0, gaps=()):
    """A dry throat rattle: irregular clicks, each a tiny struck resonance. `rate` is clicks per second
    along the way; `gaps` are (start, end) fractions where it holds its breath."""
    n = int(seconds * SR)
    r = np.random.default_rng(seed)
    x = np.zeros(n)
    t = 0.0
    while t < seconds - .02:
        frac = t / seconds
        if not any(a <= frac < b for a, b in gaps):
            i = int(t * SR)
            x[i] = r.uniform(.5, 1.0)
            if r.random() < .25 and i + 90 < n:
                x[i + int(r.uniform(40, 90))] = r.uniform(.2, .5)        # a double tick now and then
        t += (1 / float(np.interp(frac, np.linspace(0, 1, len(rate)), rate))) * r.uniform(.72, 1.3)
    y = resonate(x, [np.full(n, 820.0 * r.uniform(.92, 1.08)), np.full(n, 1650.0 * r.uniform(.92, 1.08)), np.full(n, 3100.0 * sharp)], (9, 12, 14), (1, .9, .6), block=4096)
    return y / (np.abs(y).max() + 1e-9)


def hiss_teeth(take):
    """Breath forced through teeth, with the rattle starting up underneath."""
    k = take
    d = k.around(1.5, .2)
    n = int(d * SR)
    air = k.r.standard_normal(n)
    y = resonate(air, [curve(k.bend([(0, 2600), (.4, 3600), (1, 2200)], .08), d), np.full(n, k.around(5600.0, .06)), np.full(n, k.around(8200.0, .06))], (3, 4, 5), (1, .8, .5), block=1024)
    y = y / np.abs(y).max() * curve([(0, 0), (.08, .9), (.5, 1), (1, 0)], d) * (1 + .25 * smooth_noise(n, 25, k.seed))
    rattle = clicks(d, [k.around(v, .2) for v in (9, 20, 34, 30, 14)], k.seed + 41) * curve([(0, 0), (.15, .7), (.6, 1), (1, 0)], d)
    return finish(forest(y * .8 + rattle * .7, wet=.1, seconds=.9, seed=k.seed))


def hiss_rattle(take):
    """Only the rattle: slow clicks that run together and fall apart again."""
    k = take
    d = k.around(1.9, .2)
    y = clicks(d, [k.around(v, .2) for v in (6, 10, 22, 40, 44, 24, 9)], k.seed + 43, sharp=1.15) * curve([(0, .5), (.5, 1), (1, .0)], d)
    throat = voice(d, curve(k.bend([(0, 46), (.5, 58), (1, 40)], .08), d), [420.0, 980.0], roughness=1, doubling=.7, breath=.5, drive_amount=3, seed=k.seed + 44, qs=(4, 5)) * .25 * curve([(0, 0), (.3, 1), (1, 0)], d)
    return finish(forest(y + throat, wet=.12, seconds=.9, seed=k.seed))


def hiss_growl(take):
    """A wet, low growl with air over it: close, and annoyed."""
    k = take
    d = k.around(1.7, .2)
    growl = voice(d, curve(k.bend([(0, 52), (.3, 71), (.7, 64), (1, 44)], .08, .05), d), [curve(k.bend([(0, 380), (.4, 560), (1, 340)], .07), d), k.around(1150.0, .06), k.around(2400.0, .06)],
                  roughness=1, doubling=.9, breath=.6, drive_amount=6, seed=k.seed + 45, qs=(4, 5, 6))
    air = band(k.r.standard_normal(len(growl)), 3200, 9000) * curve([(0, 0), (.2, .5), (.6, .35), (1, 0)], d)
    return finish(forest(growl * curve([(0, 0), (.1, 1), (.75, .85), (1, 0)], d) + air * .45, wet=.1, seconds=.9, seed=k.seed))


# Clicking, on its own and unhurried. Each entry: seconds, clicks per second along the way, held breaths,
# and whether it ends on an in-breath.
CLICK_TAKES = [
    (2.6, [4, 7, 12, 8, 4], (), True),                          # the short one that was liked, a little longer
    (4.2, [2.5, 3, 5, 9, 5, 3, 2], (), False),                  # slow, swelling once
    (5.0, [3, 6, 3, 2, 6, 11, 4], ((.42, .55),), False),        # stops, as if listening, then picks up
    (3.4, [1.6, 1.8, 2.2, 2, 1.7], (), False),                  # very slow: single ticks, counted out
    (6.0, [3, 5, 2, 7, 14, 18, 6, 2], ((.2, .3), (.62, .68)), True),   # long, runs together near the end
    (3.0, [10, 16, 9, 4, 2], (), False),                        # starts fast and winds down
    (4.6, [2, 2.4, 2, 4, 8, 3, 2], ((.5, .6),), True),
    (5.4, [1.4, 2, 3, 2, 1.5, 3.5, 2], ((.33, .45),), False),   # sparse, patient
]


def click_take(i):
    def make(take):
        seconds, rate, gaps, inhale = CLICK_TAKES[i]
        y = clicks(seconds, rate, take.seed + 80, sharp=take.around(.9, .12), gaps=gaps)
        y *= 1 + .3 * smooth_noise(len(y), 1.2, take.seed)        # nearer, further: it is not holding still
        breath = band(take.r.standard_normal(len(y)), 500, 2600) * curve([(0, 0), (.72, 0), (.86, .5), (1, 0)], seconds) if inhale else 0
        return finish(forest(y * .9 + breath * .5, wet=.14, seconds=.9, seed=take.seed), peak=.8)
    return make


# ----------------------------------------------------------------------------- wood
def struck_wood(n, modes, seed, decay=1.0):
    """Impulse into a handful of damped modes: what a stick does when it gives."""
    r = np.random.default_rng(seed)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for f, tau, g in modes:
        f *= r.uniform(.94, 1.06)
        y += g * np.sin(2 * np.pi * f * t + r.uniform(0, 6.28)) * np.exp(-t / (tau * decay))
    return y


def snap(seed, size=1.0):
    """One fibre bundle letting go."""
    n = int(.22 * SR)
    r = np.random.default_rng(seed)
    # Mostly the break itself: a broadband click a couple of milliseconds long, with a rougher few-millisecond
    # tail of splintering. The stick's own ring is short and quiet, or it reads as a knock on something hollow.
    hit = r.standard_normal(n) * (np.exp(-np.arange(n) / (SR * .0012)) + .35 * np.exp(-np.arange(n) / (SR * .009)))
    hit = highpass(hit, 900 / size)
    base = r.uniform(.8, 1.25)
    modes = [(540 * base / size, .006, .5), (1180 * base / size, .0045, .45), (2050 * base / size, .003, .4), (3300 * base / size, .002, .3), (5200 * base / size, .0015, .25)]
    return hit * 2.2 + struck_wood(n, modes, seed)


def place(parts, seconds):
    y = np.zeros(int(seconds * SR))
    for at, gain, x in parts:
        i = int(at * SR)
        m = min(len(x), len(y) - i)
        if m > 0:
            y[i:i + m] += x[:m] * gain
    return y


def branch_dry(take):
    """A dry stick underfoot: one hard snap and its small after-cracks."""
    r = take.r
    parts = [(.02, 1.0, snap(take.seed))] + [(.02 + r.uniform(.03, .2), r.uniform(.12, .35), snap(take.seed * 7 + i, r.uniform(.6, .9))) for i in range(int(r.integers(2, 6)))]
    return finish(forest(place(parts, .7), wet=.14, seconds=1.0, damp=6500, seed=take.seed), fade_out=.2)


def branch_green(take):
    """A green limb: it creaks, tears along the grain, then goes."""
    d = 1.5
    n = int(d * SR)
    r = take.r
    tear = np.zeros(n)
    t = .05
    while t < .82:                                           # fibres parting faster and faster
        i = int(t * SR)
        s = snap(int(r.integers(1e6)), r.uniform(.55, 1.1)) * r.uniform(.12, .4) * (t / .82) ** 1.5
        m = min(len(s), n - i)
        tear[i:i + m] += s[:m]
        t += r.uniform(.012, .09) * (1.25 - t)
    creak = voice(.8, curve([(0, 95), (.6, 150), (1, 240)], .8, "exp"), [700.0, 1900.0], roughness=1, doubling=.5, breath=0, drive_amount=2, seed=take.seed + 53, qs=(18, 22))
    parts = [(0, 1, tear), (0, .22, creak * curve([(0, 0), (.3, 1), (1, .2)], .8)), (.84, 1.3, snap(take.seed + 54, 1.5)), (.9, .5, snap(take.seed + 55, 1.9))]
    return finish(forest(place(parts, d), wet=.15, seconds=1.2, damp=6000, seed=take.seed), fade_out=.25)


def branch_heavy(take):
    """Something heavy breaks deadwood and it drops through the brush."""
    d = 2.0
    n = int(d * SR)
    r = take.r
    # The weight landing: a dull thump with no note in it. Dense wood on soil does not ring.
    thud = lowpass(r.standard_normal(int(.3 * SR)) * np.exp(-np.arange(int(.3 * SR)) / (SR * .022)), 260, 3) * 6
    brush = np.zeros(n)
    for _ in range(26):                                      # twigs and needles on the way down
        at = r.uniform(.25, 1.5)
        g = r.uniform(.03, .12) * (1 - (at - .25) / 1.4)
        i = int(at * SR)
        s = snap(int(r.integers(1e6)), r.uniform(.35, .6)) * g
        m = min(len(s), n - i)
        brush[i:i + m] += s[:m]
    rustle = band(r.standard_normal(n), 1800, 7000) * curve([(0, 0), (.12, 0), (.2, .12), (.6, .07), (1, 0)], d) * (1 + smooth_noise(n, 18, take.seed + 63))
    parts = [(.03, 1.2, snap(take.seed + 64, 1.9)), (.07, .7, snap(take.seed + 65, 1.3)), (.1, .9, thud), (0, 1, brush), (0, .6, rustle)]
    return finish(forest(place(parts, d), wet=.18, seconds=1.4, damp=5000, seed=take.seed), fade_out=.3)


# ----------------------------------------------------------------------------- knocks
def knock(seed, force=1.0):
    """One rap of something hard on a standing trunk. A living trunk is solid: nearly all of it is the impact
    itself, a dead 'tock' with a low thump under it and almost no note. Any ring makes it a hollow log."""
    r = np.random.default_rng(seed)
    n = int(.9 * SR)
    t = np.arange(n) / SR
    noise = r.standard_normal(n)
    click = band(noise, 700, 3200) * np.exp(-t / .0035)
    body = lowpass(noise, 420, 3) * np.exp(-t / .016) * 5
    thump = np.sin(2 * np.pi * (r.uniform(92, 118) * (1 + .5 * np.exp(-t / .012))) * t) * np.exp(-t / .028)
    tick = struck_wood(n, [(r.uniform(1050, 1400), .0045, .3), (r.uniform(2100, 2700), .003, .2)], seed)
    return (click * 1.0 + body * .9 + thump * .8 + tick) * force


# When the knocks come. Unhurried, and never quite even: something that knows it is being listened to.
KNOCK_PATTERNS = [
    [(.05, 1.0), (.42, .85), (1.25, .95)],                      # two, then one late
    [(.05, .9), (.95, 1.0)],                                    # two, slow
    [(.05, 1.0), (.5, .8), (.95, .85), (2.0, 1.0)],             # three even, a long wait, one more
    [(.05, 1.0)],                                               # once
]


def knocks(pattern):
    def make(take):
        r = take.r
        hits = [(at + (r.uniform(-.03, .03) if i else 0), g * r.uniform(.85, 1.1)) for i, (at, g) in enumerate(KNOCK_PATTERNS[pattern])]
        y = place([(at, g, knock(take.seed * 13 + i)) for i, (at, g) in enumerate(hits)], hits[-1][0] + .9)
        return finish(forest(y, wet=.16, seconds=1.1, damp=3800, seed=take.seed), peak=.86, fade_out=.3)
    return make


# ----------------------------------------------------------------------------- calls
def call_moan(take):
    """A long hollow moan from far off: almost a voice, wrong at the end."""
    k = take
    d = k.around(3.4, .15)
    pitch = curve(k.bend([(0, 205), (.15, 262), (.55, 251), (.8, 196), (1, 150)], .06, .04), d, "exp")
    pitch *= 1 + .012 * np.sin(2 * np.pi * k.around(4.6, .15) * t_axis(d)) * curve([(0, 0), (.3, 1), (1, 2.2)], d)
    crack = k.around(.82, .08)
    y = voice(d, pitch, [curve(k.bend([(0, 430), (.3, 620), (1, 380)], .06), d), curve(k.bend([(0, 980), (.3, 1250), (1, 860)], .06), d), k.around(2600.0, .05)],
              roughness=curve([(0, .15), (.7, .3), (1, 1)], d), doubling=curve([(0, 0), (crack - .04, 0), (crack + .04, 1), (1, 1)], d), breath=.25,
              gain=curve([(0, 0), (.12, .8), (.5, 1), (.85, .7), (1, 0)], d), drive_amount=2.2, seed=k.seed + 71, qs=(6, 8, 9))
    return y


def call_drone(take):
    """From the reveal recording, slowed: the same thing, a long way off."""
    k = take
    x = reveal_excerpt(float(k.r.uniform(2.2, 4.6)), 2.6)
    y = signal.resample(x, int(len(x) * k.around(1.9, .12)))
    d = len(y) / SR
    return y / np.abs(y).max() * curve([(0, 0), (.25, 1), (.6, .9), (1, 0)], d)[: len(y)]


def call(kind):
    def make(take):
        if kind == "moan":
            y = call_moan(take)
        elif kind == "drone":
            y = call_drone(take)
        return finish(far(y, take.around(55, .15)), fade_out=.6)
    return make


SOUNDS = {}
for i in range(5):
    SOUNDS[f"screech_{i + 1}"] = (screech, 300 + i)
for i, (fn, base) in enumerate(((hiss_teeth, 400), (hiss_teeth, 401), (hiss_rattle, 410), (hiss_rattle, 411), (hiss_growl, 420), (hiss_growl, 421))):
    SOUNDS[f"hiss_{i + 1}"] = (fn, base)
for i, (fn, base) in enumerate(((branch_dry, 500), (branch_dry, 501), (branch_dry, 502), (branch_green, 510), (branch_green, 511), (branch_heavy, 520))):
    SOUNDS[f"branch_{i + 1}"] = (fn, base)
for i, kind in enumerate(("moan", "moan", "drone", "drone")):
    SOUNDS[f"call_{i + 1}"] = (call(kind), 600 + i)
for i in range(len(CLICK_TAKES)):
    SOUNDS[f"clicks_{i + 1}"] = (click_take(i), 700 + i)
for i in range(len(KNOCK_PATTERNS)):
    SOUNDS[f"knock_trunk_{i + 1}"] = (knocks(i), 800 + i)


def write(name, x):
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "x.f32")
        x.astype(np.float32).tofile(raw)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", raw, "-c:a", "libmp3lame", "-q:a", "3", os.path.join(OUT, name + ".mp3")], check=True)


if __name__ == "__main__":
    wanted = sys.argv[1:] or list(SOUNDS)
    if not sys.argv[1:] and os.path.isdir(OUT):
        for old in os.listdir(OUT):                                  # a full run leaves exactly the current set
            if old.endswith(".mp3"):
                os.remove(os.path.join(OUT, old))
    for name in wanted:
        fn, seed = SOUNDS[name]
        x = fn(Take(seed))
        write(name, x)
        rms = 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)
        print(f"{name:16s} {len(x) / SR:5.2f} s  peak {np.abs(x).max():.2f}  rms {rms:6.1f} dB", flush=True)
