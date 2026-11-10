"""blender --background --factory-startup --python build.py -- [asset ...]"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import kit  # noqa: E402
import models_cabin  # noqa: E402

ASSETS = {"cabin": (models_cabin.cabin, models_cabin.SHOTS)}
for mod in ("models_relay", "models_lookout", "models_small", "models_clutter", "models_bridge", "models_truck", "models_mine", "models_camp", "models_chapel", "models_rocks"):
    try:
        m = __import__(mod)
    except ModuleNotFoundError:
        continue
    ASSETS.update(m.ASSETS)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
# Parked until it is good enough to go back in the world; name it explicitly to build it.
PARKED = {"pickup"}
chosen = argv or [name for name in ASSETS if name not in PARKED]
path = os.path.join(kit.ROOT, "game/world-assets.json")
table = json.load(open(path)) if os.path.exists(path) else {}
for name in chosen:
    fn, shots = ASSETS[name]
    made = fn()
    table[name] = made if isinstance(made, dict) else kit.build(made, shots)
    with open(path, "w") as f:
        json.dump(table, f, indent=1)
kit.log("WORLD_V2_DONE", chosen)
