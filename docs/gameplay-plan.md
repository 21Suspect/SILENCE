# Gameplay: the plan for step 1, "the loop, alone, with one way out"

The design is docs/game-design.md. This is how step 1 of its build order gets made, against the code as it was on 2026-11-17
(one night, three lives, a sighted and hearing creature, a fixed fuel-and-fuses chain that ends at "signal sent").

## The contract every part shares: the noise scale

game/sim/noise/noise-scale.ts (done). A noise's `loudness` is the distance it is heard within, in hundreds of metres; heard
inside, not outside, no falloff. The grade is the sound's class: faint (< 30 m), loud (30 to 100 m), very loud (100 m and up,
or kept up). `NOISE` holds the design's table; `footstepNoise` replaces creature-brain's `footstepLoudness`; `WEATHER_COVER`
shortens distances (weather itself is step 2). Every emitter in the game moves onto `NOISE` values.

## Wave 1: four pure pieces, in parallel (sim modules and their tests, no engine wiring)

| Piece | Owns | What it is |
| --- | --- | --- |
| A. The blind Listener | game/sim/creature/creature-brain.ts, game/render/creature/encounters.ts, their tests | No sight. Three grades: faint (stop, turn, drift; forget after 10 s of silence), loud (one call, trot to the spot, search 20 s listening), very loud or kept up (run at twice the player's sprint, stay while it lasts). A second noise redirects it. Hears breathing within 3 m unless held. By day asleep in its lair: a very loud noise anywhere, or a loud one near the lair, wakes it for a while. At dusk it leaves the lair for the loudest place of the day, then a round of the day's noisy places and the roads and paths. Worse each day: out earlier, searches longer, from day 4 a light sleeper. The torch still stuns it. Tells: its call when it hears a loud noise, clicks while it searches. |
| B. The run | game/sim/run/run.ts (new), game/sim/run/day-noise.ts (new), tests | Five days. Dawn and dusk events. Caught: wake by the bed at the next dawn with everything carried. Sleep in a bed till dawn if the place is quiet and its door barred; if it was loud there that day, the Listener comes to the door. Lost at the sixth dawn. Won by leaving. A day's noise log: its loudest place, its noisy places, whether a spot was loud today. |
| C. Parts and the helicopter | game/sim/objectives/objectives.ts, objective-text.ts, game/sim/run/parts.ts (new), game/sim/world/world-layout.ts (lair and landing pad sites only), tests | The helicopter's parts placed by the seed: the call (a can of fuel and three fuses, at the relay hut) and the pad (bulbs, cable, a can of fuel for its lights), from at least three quarters of the island, one in the lair. Heavy parts (fuel) ride in the hands only, at a walk. Crates at the relay hut and the pad and a chest at the cabin bank parts for the run. The board at the cabin names each part's area. The call: the helicopter comes at the next dawn and lands only on a lit pad; its noise is the whole island; boarding wins. |
| D. Breath, ground and the bicycle | game/sim/player/breath-hold.ts, game/sim/world/surface.ts, game/sim/player/bicycle.ts (all new), tests | Hold your breath: 8 s, less when winded, then a gasp. One query for the ground under a point: road, path, forest, water, beach. The bicycle: three times walking speed and nearly silent on roads and paths, slow and loud off them; a bell; a heavy part strapped on makes it slower and rattle (25 m). |

## Wave 2: into the game (one at a time, each reviewed and tested in the browser)

1. The run and the Listener in the engine: day counter and dawn wake by the bed, the catch without lives, the lair, the noise
   log, breath hold on a key, every emitter on the scale, the playtest bot on the same modules.
2. Parts, crates, the chest and the board in the world (objectives-runtime, interaction prompts, HUD text).
3. The bicycle in the world: mount and dismount, riding, the bell, strapping a heavy part, back at the cabin on waking.
4. The landing pad and the finale: the pad's lights and fuel, the call, the helicopter at dawn, the light that holds the
   Listener at the pad's edge, boarding, the win.

## Models (Blender, tools/assets/world-v2)

Bicycle (frame, fork, wheel, cranks: models_bicycle.py), landing pad with its ring of lights and generator, helicopter,
bulbs, a cable reel, the tally of days by the bed, the cabin chest. The board, crates, jerry cans, fuses, the generator and
the relay hut exist.

## Status

- [x] Noise scale
- [x] Wave 1: A, B, C, D (2026-11-17)
- [ ] Wave 2: [x] 1 (the run and the Listener in the engine), [ ] 2, [ ] 3, [ ] 4
- [ ] Models: [x] bicycle (rebuilt on a reference roadster), [x] landing pad, bulbs, cable; [ ] helicopter; [ ] tally, chest

## Decisions from the user's play feedback (2026-11-17)

The questions the design left open, answered so the code can follow one rule each.

- **The bicycle moves like one.** The wheels turn with the ground speed; the cranks turn with the rear wheel through the
  gearing (a 46-tooth ring and an 18-tooth sprocket: the cranks once for every 2.56 turns of the wheel); the fork and bars
  turn about the steering axis with the steering; the bike leans into curves (lean from speed and turn rate, a few degrees
  at walking pace, up to about 20 at speed), and the camera rides it from the saddle in first person, the hands on the
  grips (frame hooks: saddle, bars; fork hooks: grip_left, grip_right).
- **A generator is on or off.** Its noise is one source that sounds for as long as it runs, not a beep every seven seconds.
  The hearing model keeps a set of running sources (generator, pump, the pad's generator, the helicopter) that the Listener
  hears whenever it is inside their reach; one-off sounds stay events.
- **The Listener turns its head to what it hears.** Blind, it still faces sound: its face follows the last noise it took up,
  and when it hears breathing close by its face finds the breath. It never tracks a silent player.
- **Close by, sneaking is the way out.** A crouch-walk is heard within 6 m and breathing within 3 m: inside 3 m you hold
  your breath and keep still; between 3 and 6 m you hold still or creep away; past 6 m you can sneak off. Thrown things
  (a bottle, a stone) are the cheap lure for leading it away (step 2, with the other lures).
- **It is fast.** It runs at twice the player's sprint; its gait must keep up and stay readable.
- **It sounds like it moves.** Footfalls on every surface (leaves and earth, rock, wood, the road, water), quick and light for
  eight legs, varied so they never repeat, louder when it runs; plus the scrape of climbing on bark and rock. (A sound task.)
- **Indoors.** It is too big to come in. Loud inside, and it comes to the building: it crawls over the walls and the roof
  (you hear it above you), tries the doors and reaches in with its long arms through an open door or window (within about
  2.5 m of an opening you can be taken). A shut door it forces after a while if the noise keeps up; a barred door holds
  longer; boards and nails (step 2) hold longest. Quiet inside, and it searches outside and moves on.
- **The lair stays.** By day it sleeps; only a very loud noise anywhere or a loud one near the lair wakes it, so ordinary
  daytime work does not keep bringing it out. To be judged in play.
- **On slopes and walls its body follows the surface**, parallel to the ground under its feet, as on trees.
- **The helicopter comes for you**, as designed: called from the relay hut, it arrives at dawn and lands only on the lit pad,
  and its noise brings the Listener running while the pad's light holds it at the edge. A cutscene of it lifting off, the
  Listener watching from below, can come later. The model stays modest.

## The quest flow and finding things (2026-11-17, from play)

The first HUD followed the code's order (fuel, start the generator, then hunt fuses with it roaring) and the only help in
finding parts was the board's "around the chapel". Play showed both: a running generator held the Listener for ever (one can,
a free lure), and a search was a walk in a random direction. The rules now:

- **The call, quietly.** Fuses go into the relay hut's fuse box at any time; only the radio needs power. So: find the three
  fuses (quiet work), then fuel and start the generator, transmit, and switch it off again (a switch on the generator). It
  burns fuel only while it runs: one can runs it 4 game hours (4 minutes of play), and it stops when the can is dry.
- **A running generator is a lure with a price.** The Listener runs to it and prowls round it in widening rings while it runs,
  hunting whoever started it; it never waits there idle. Switched off or dry, it searches and moves on. So a generator pulls
  it across the island for a few minutes, for a can of fuel.
- **The quest HUD** is the next thing to do and, under it, a short checklist of what that needs and where each piece is
  ("Fuse: around the ruin", ticked when fitted, "banked at the relay hut" when banked), grouped by what it is for.
- **The board** at the cabin lists the same parts in two groups: for the call at the relay hut, and for the landing pad.
- **Help in finding things, not a marker** (game/sim/world/places.ts names every place once):
  - The paper map (M): the island drawn by hand, its coast, lake, river, roads and paths and every named place. The places the
    board names for parts still missing are ringed in pencil; the relay hut and the pad are drawn bold. There is no "you are
    here", except while you stand at a named place (as if read off its sign). Reading it does not pause the game.
  - Walking into a named place shows its name for a few seconds.
  - A part lying out catches light: in the torch beam (within about 28 m) or by day (about 12 m) it glints, so searching a
    place is a sweep of the torch, not a pixel hunt.
- **Later: stones and branches to throw** (the user, after the first full playthrough of the flow). A few lie about, seeded
  here and there (not everywhere), and a pocket holds only a handful (about three), so throwing is a short lure, never an
  endless one: a stone or branch lands with a noise where it lands, heard by the Listener like any other. It needs impact
  sounds for stones and sticks on each surface (earth, rock, wood, metal, water). After the map and the quest work.
