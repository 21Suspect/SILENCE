# Architecture

SILENCE is a first-person horror game in the browser: TypeScript, three.js r180, built by Vite into a static site. A ~900 m
coastal island is generated from a seed and streamed round the player; a creature (the Listener) hunts by sound and sight.

## Layout

```
index.html            page shell; loads game/main.ts
game/                 all game code
  main.ts             entry point: starts the game in <main id="game">
  core/               engine.ts (main loop, input, camera, frame order, dev hooks), settings, resolution (quality.ts),
                      perf switches (perf-flags.ts), time slicing (time-slice.ts), tap detection
  sim/                rules and simulation in plain TypeScript: no three.js, no DOM
    creature/         the Listener's mind: brain (behaviours, CREATURE_TUNING), navigation, sighting, the scripted opening
                      (director), visibility, surface climbing, articulation
    player/           stamina, ladders, breathing, lives
    world/            heights and geography (world.ts), noise, landform, coast, seeded layout of POIs (world-layout.ts),
                      natural placement, roads, water depth, the collision world (collision.ts)
    objectives/       objective state and its text
  render/             everything drawn with three.js
    world/            terrain (+ terrain-worker), forest, undergrowth, vegetation batches, river, sky, atmosphere (fog and
                      post chain), sun shadows, street lights, power lines, materials (texture-variation.ts patches;
                      bark-relief.ts gives trunks parallax, sun self-shadow and cavity; relief-math.ts mirrors the ground's
                      relief march and patch height blend), ambient life
    props/            POIs (streamed GLB props), doors, the rebuilt world's assembly (world-v2.ts), story props,
                      interaction prompts, objective props, the flashlight
    creature/         encounters.ts (hosts the brain in the scene), the Listener's model, rig and gait, tree crawl
    gpu/              warm-up queue, tiled texture uploads, shadow programs, unlit-light guards
  audio/              Web Audio: ambience, creature sounds, footsteps, breathing
  ui/                 pause menu (admin.ts), objective and stamina HUD, performance overlay and its statistics
  dev/                development only: perf probe, spider lab (?spider-lab), door test (?door-test), telemetry
  data/               world-assets.json (props: URLs, colliders, doors, ladders) and spider-rig.json, both written by
                      tools/assets
tests/                node:test suites in the same folders as the code; tests/helpers lets Node load extensionless imports
tools/
  assets/             Blender pipeline: world-v2 props (build.py, kit.py, review.py), creature-v2, coastal textures, audio
  ghosting/           the ground's texture-ghosting diagnostic: in-page runner, receiver, metrics, report (see AGENTS.md)
  playtest/           headless playtest bot, night runner and report, creature and navigation probes, map renderer
  sounds/             dev soundboard page (/tools/sounds/ under npm run dev)
  world-map.mjs       top-down maps of generated worlds
public/               served as is: GLB models, textures, audio, sky
assets/               editable sources: .blend files, art, review captures (not served)
docs/                 design notes (creature-ai-plan.md)
```

## Rules

- **sim/ imports nothing from render/, ui/, audio/, core/ or three.js, and touches no DOM** (world-flags.ts reads the URL's
  ?seed and ?classic-world when there is one). It is the part a port to Unity or another engine can translate one file at a
  time, and it runs headless in Node (tests, the playtest bot).
- **render/, ui/ and audio/ read sim/, never the reverse.** core/engine.ts wires them together.
- **Tuning and layout are data where they can be:** props in game/data/world-assets.json (written by the pipeline, never by
  hand), POI placements and the creature's numbers in named constants (world-layout.ts, CREATURE_TUNING in creature-brain.ts).
- **No frame does a big job at once.** Long CPU work is a generator run a slice per frame (time-slice.ts) into a hidden
  double buffer that swaps when whole (forest, undergrowth); GPU work (texture tiles, shader programs, shadow programs) goes
  through the warm-up queue (render/gpu) before anything that needs it is shown. Terrain chunks are built in a worker.
- **Nothing pops.** Level-of-detail changes are dithered fades in the shaders, by distance from the eye.

## A frame (core/engine.ts, animate)

Input and the frame rate limit → sky and sun → player movement and collision → terrain streaming → forest and undergrowth
slices → world props, doors, objectives → the creature (encounters.ts runs the brain from sim/creature) → shadow map
cadence → audio → draw (atmosphere.ts: shadows, scene, water, fog, resolve, anti-aliasing) → one GPU warm-up step →
performance overlay. The render size is the player's resolution choice (core/quality.ts); nothing scales it on its own.

## Not engine-agnostic yet

These sim-like modules still use three.js math types and live under render/: the gait solvers (render/creature/spider-gait,
creature-gait), tree-crawl, objectives-runtime, and the encounters host. A port would split their maths out first.
render/creature/creature-model.ts, sim/creature/creature-articulation.ts and creature-gait.ts belong to the first creature
(public/creature/silence-creature.glb, assets/creature/) and are no longer loaded by the game; only tests use them.
