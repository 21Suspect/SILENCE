# Working on SILENCE

Guide for people and coding agents. The code map is [ARCHITECTURE.md](ARCHITECTURE.md); the player-facing description is
[README.md](README.md).

## Commands

```sh
npm ci                 # install (Node 22.13+, CI uses 24)
npm run dev            # http://localhost:5173 (port is fixed)
npm run typecheck      # tsc --noEmit over game/
npm run lint           # eslint; warnings are allowed, errors are not
npm test               # node:test, tests/**/*.test.mjs (about a minute)
npm run build          # static site in dist/
npm run preview        # serve dist/ locally
```

One test file: `node --experimental-strip-types --no-warnings --test tests/sim/creature/creature-brain.test.mjs`.
CI (.github/workflows/checks.yml) runs typecheck, lint, test and build on every push to main and every pull request.

Tools: `node --experimental-strip-types --no-warnings tools/playtest/run.mjs --seeds 4 --jobs 4` (bot nights; keep jobs at 4
or fewer), `tools/playtest/nav-probe.mjs`, `tools/playtest/creature-run.mjs`, `tools/playtest/map.mjs`. Rebuild a prop with
Blender 5.1: `blender --background --factory-startup --python tools/assets/world-v2/build.py -- cabin` (writes
public/world/cabin.glb and game/data/world-assets.json; commit both together).

Buildings rebuilt for detail use the tiled pipeline (`Model(..., tiled=True)`, tools/assets/world-v2/tiled.py): shared CC0
scans in public/world/materials (`python3 tools/assets/world-v2/library.py fetch` then `pack`) at 900 to 2000 texels per
metre, plus a small baked macro map per prop (occlusion with sky openness, moss, grime, tone); the game hangs the shared maps
on them in game/render/props/prop-materials.ts. Detailed parts (round logs, displaced masonry, corrugated iron, settled
firewood) are in parts_hq.py. Every build prints a support audit (support.py: `SUPPORT ... N FLOATING`, details in
work/gfx/audit): nothing may float, so get it to 0 before showing a prop.

Ground ghosting, in numbers: tools/ghosting (page.js runs fixed poses x switches in the dev server's tab and posts stills and
JSON to receiver.mjs; measure.mjs writes the table; metrics.mjs is the maths, tested in tests/tools/ghosting). The relief
march's maths is mirrored in game/render/world/relief-math.ts. `perfOn('groundRelief')` off builds the first version of the
ground's relief shader, for A/B.

## Conventions

- **Where code goes:** rules and simulation without three.js or the DOM go in game/sim/; anything drawn goes in
  game/render/; menus and HUD in game/ui/; development-only helpers in game/dev/. sim/ must not import from render/, ui/,
  audio/, core/ or three.js.
- **Tests** live in the same folder path under tests/ as the module they test. Tests that import game modules with
  extensionless imports first `import '../../helpers/register-ts-hooks.mjs'` (adjust the depth) and then load the module
  with a dynamic `await import(...)`.
- **Imports** inside game/ are relative and extensionless (Vite resolves them); JSON is imported directly.
- **Comments say why**, in plain sentences, with measured numbers where a choice was measured. Keep the existing dense style
  of a file when editing it.
- **No hitches:** long work runs in slices (core/time-slice.ts) or in the GPU warm-up queue (render/gpu); LOD changes fade.
  Optimisations that can be A/B tested ask `perfOn('name')` (core/perf-flags.ts); `?perf-baseline` turns them all off.
- **Visual changes** need before/after screenshots at the same pose and clock. Judge them harshly; visible popping is a bug.

## Measuring in a browser

Development builds expose `window.__SILENCE__`: `snap()` runs one frame, `teleport(x, z)`, `look(yaw, pitch)`,
`setHours(h)`, `setRatio(r)`, and `perf.*` (`drive(true)` runs the simulation without focus, `hold('forward', 'sprint')`,
`start()`/`stop()` per-frame rows, `settled()`, `warmup()`, `gpuStages()`, `drawList()`). `window.__WORLD__` exposes the
POIs, doors and lights. P toggles the performance overlay (FPS, lows, CPU and GPU ms). A hidden browser tab does not run
animation frames: drive frames with `snap()` and drain the GPU with a one-pixel `readPixels`.

## Git

- main is shared with a collaborator who also pushes to it: fetch and merge origin/main before starting and before
  pushing; never force-push, never rewrite pushed history.
- Moves are pure renames in their own commit (so history and blame follow), separate from edits.
- work/ is local scratch (git-ignored, about a gigabyte): measurements, captures, research notes. Do not commit it.
- Pushing does not deploy anything; the built dist/ is put on a host by hand.
