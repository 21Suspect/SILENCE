"""Prepares the forest ambience beds from CC0 field recordings.

    python ambience.py <folder with the downloaded mp3s>     (needs numpy and ffmpeg)

Sources: bigsoundbank.com (Joseph Sardin), all CC0. Download the MP3 of each sound number below into one folder
as <number>.mp3. Each bed is levelled, trimmed and closed into a seamless loop (its tail is cross-faded into its
head), then written to public/audio/ambience/. The game never plays a bed from the top: see game/audio.ts.
"""
import os
import subprocess
import sys
import tempfile

import numpy as np

SR = 44100
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(ROOT, "public/audio/ambience")

# name: (sound number, start s, length s or None for all, target RMS dB, channels, kbps)
BEDS = {
    "day_1": ("2749", 2, 210, -27, 2, 96),      # Forest #4: birds, wind
    "day_2": ("1348", 20, 210, -27, 2, 96),     # Forest #2
    "night_1": ("0110", 1, 72, -30, 2, 96),     # Countryside at night #1
    "night_2": ("0555", .5, 28, -32, 2, 96),    # Forest at night after rain
    "wind": ("0904", 3, 200, -30, 2, 80),       # Forest: wind in the trees
    "owls": ("0429", 0, None, -30, 1, 80),      # Tawny owls: played now and then from far off, not looped
}
FADE = 5.0   # seconds of tail folded into the head


def read(path, start, length, channels):
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "x.f32")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start)] + (["-t", str(length)] if length else []) + ["-i", path, "-ac", str(channels), "-ar", str(SR), "-f", "f32le", raw]
        subprocess.run(cmd, check=True)
        return np.fromfile(raw, np.float32).astype(float).reshape(-1, channels)


def loop(x):
    """Equal-power cross-fade of the last FADE seconds into the first, so the end meets the start."""
    n = int(FADE * SR)
    t = np.linspace(0, np.pi / 2, n)[:, None]
    head, tail = x[:n], x[-n:]
    return np.concatenate([head * np.sin(t) + tail * np.cos(t), x[n:-n]])


def write(name, x, kbps):
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, "x.f32")
        x.astype(np.float32).tofile(raw)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[1]), "-i", raw, "-c:a", "libmp3lame", "-b:a", f"{kbps}k", os.path.join(OUT, name + ".mp3")], check=True)


if __name__ == "__main__":
    source = sys.argv[1]
    for name, (number, start, length, level, channels, kbps) in BEDS.items():
        x = read(os.path.join(source, number + ".mp3"), start, length, channels)
        x -= x.mean(axis=0)
        if name != "owls":
            x = loop(x)
        else:
            k = int(.3 * SR)
            x[:k] *= np.linspace(0, 1, k)[:, None]
            x[-k:] *= np.linspace(1, 0, k)[:, None]
        rms = np.sqrt((x ** 2).mean())
        x *= 10 ** (level / 20) / (rms + 1e-9)
        x = np.tanh(x * 1.2) / 1.2 if np.abs(x).max() > .95 else x      # a soft ceiling for the odd loud bird
        write(name, x, kbps)
        print(f"{name:8s} {len(x) / SR:6.1f} s  rms {20 * np.log10(np.sqrt((x ** 2).mean())):6.1f} dB  peak {np.abs(x).max():.2f}", flush=True)
