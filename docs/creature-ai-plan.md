# The Listener: behaviour, lethality and sound plan

Approved by Oscar on 2026-11-10 ("you have my full go, all of the points"). This is the plan of record for
turning the creature from a scheduled apparition into a persistent, sensing, adaptive hunter.

## Why

Today the creature (`game/encounters.ts`, body in `game/listener.ts`):

- never comes for the player: it aims for a point 14 m ahead and 7 m beside them, backs off inside 9-10 m and
  leaves a few seconds after being seen. There is no chase, grab, damage, death or lives anywhere in the game;
- only exists on a schedule (two evening appearances, then one every 110-170 s) and is not in the world between them;
- is deaf and nearly blind: noise events already exist (`ObjectiveEvent` `type:'noise'`, `objectives-runtime`
  `subscribe/emit`, ladder rungs and splashes from `world-v2.ts`) but nothing subscribes; `encounters.update`
  receives only `(dt, elapsed, player, forward, darkness, hours)`, not sprint, crouch, flashlight or velocity;
- uses the tree once (second encounter), and climbs down the moment it is recognised;
- has one sound file (`public/audio/scary sound.mp3`, played at every spawn) plus a synthesized `stalkCue`
  (max 3 per encounter). `cue('breath')` exists and is never called.

## Design

### 1. It is always somewhere
One persistent creature with a real position at all times. Unseen, it still travels (cheaply simulated when far),
so every sound comes from where it actually is. Scheduled spawns go away.

### 2. Senses
- **Hearing.** Footsteps by surface and speed (sprinting on gravel is loud, crouching on moss nearly silent),
  flashlight click, ladder rungs, splashes, pickups and drops, generator, radio. Each noise has a loudness and a
  position; whether the creature hears it depends on distance. A heard noise becomes a rough "last heard here".
- **Sight.** Line of sight to the player, with a much longer range at night when the flashlight is on.
- **Memory.** Last sensed position and its age, where the player tends to go, where they hide.

### 3. Decisions, not a script
A utility selector: every behaviour scores itself against the current situation each decision tick and the best
one runs (with hysteresis so it does not flicker).

| Behaviour | What it does |
|---|---|
| Roam | Patrols between the places the player needs (cabin, relay, mine, ...). |
| Investigate | Goes to a noise, slowly, head sweeping. |
| Shadow | Paces the player off the trail at the edge of the fog; stops when they stop. |
| Watch | Sits in a tree or stands at the treeline staring, perfectly still, eyes catching the light. Look away and back and it is closer, or gone. |
| Bluff | Steps into the open, lets itself be seen, melts back. |
| Cut off | Predicts where the player is heading and waits ahead instead of following. |
| Hunt | Full charge, up to about 6.5 m/s, when it has the player in the open. |
| Strike | The grab. |
| Withdraw | Breaks off, circles, returns from another side. |

### 4. It adapts to the player
Simple running statistics shift the scores:
- hides in buildings -> waits outside, circles, scrapes the walls;
- always sprints away -> stops chasing and cuts off;
- keeps the light on it -> approaches from behind the beam;
- stands still a lot -> creeps closer each time;
- makes noise at the generator -> treats that spot as a hunting ground.

### 5. Dread is paced
A hidden tension value drives boldness. It rises with night, objective progress and time since the last scare,
and drops after a chase. Early evening it only watches; by deep night it hunts.

### 6. It can kill, and the player can fight for their life
- If it reaches the player it grabs them: the camera is wrenched to its face, it screeches, cut to black.
- **Three lives.** The player wakes at the cabin with the night further along; whatever they carried stays where
  it was dropped. After the third death: game over, restart the night.
- **Counterplay:** break line of sight; go quiet (crouch, light off); get indoors; pin it with the flashlight,
  which makes it flinch and hesitate for a few seconds and works less well each time.
- **Distractions:** the radio or generator pulls it away.

### 7. Sound
Synthesized for now (procedural, in `game/audio.ts`), each emitted from the creature's real position:
low clicking/chitter when near but unseen; wet breathing when very close behind; claws on bark above; branches
cracking that move with it; a distant call when it has lost the player; a screech when the hunt starts; a grab
sting; and the forest going quiet when it is within about 25 m. No birds of any kind (standing rule).

### On "proper AI"
Senses, memory, scored decisions and a pacing director (the Alien: Isolation approach). Adaptive and
unpredictable but tunable. Not a neural network.

## Stages

1. **It becomes dangerous.** Persistent creature; hearing and sight wired to real player state;
   Roam / Investigate / Shadow / Hunt / Strike / Withdraw; the grab; three lives and respawn; flashlight flinch.
2. **It becomes creepy.** Watch (tree and treeline staring), Bluff, Cut off, the tension director, the full
   sound set.
3. **It becomes smart and moves better.** Learning the player's habits; feet placed on stumps, rocks, logs and
   trunk bases; knees that avoid obstacles (the three `todo` tests in `tests/spider-gait.test.mjs`).

## Constraints

- Creature v2 at `SPIDER_SCALE` 1.15 is the creature; never scale the head alone.
- The procedural sound system that was removed (`game/sound/`) stays out; creature sounds live in `game/audio.ts`.
- CI must stay green: `npx tsc --noEmit` and `node --experimental-strip-types --test tests/*.test.mjs`.
- Keep the brain pure and testable (no three.js scene access, injected random and clock), so a multiplayer host
  can own it later; all other game state already replays deterministically.
- `encounters.ts` protects the creature from popping in or out in view (`protectedNow`, the off-screen latch).
  Keep that rule for teleports and despawns; a persistent creature that walks into view is fine.

## Amendment: scripted opening, closer free roam, three-phase stun

Approved by Oscar on 2026-11-10 after playing stage 1: five minutes of walking produced no sighting and no
sound. "People that play wanna see the creature." At least two encounters must have happened by six minutes.

One game hour is one real minute; the game starts at 16:00.

| Real time | What happens |
|---|---|
| 0:00-1:30 | Forest only. |
| 1:30-3:00 | Encounter 1, the glimpse. Seen by 3:00, guaranteed. |
| 3:00-3:45 | Quiet; one distant call from where it went. |
| 3:45-6:00 | Encounter 2, the tree. Seen by 6:00, guaranteed. |
| after | 60-90 s of breathing room, then free roam: it can hunt and kill. |

Neither scripted encounter can hurt the player.

### Encounter 1: the glimpse
- Placed out of view, 25-35 m away, ahead of the player and to one side of their direction of travel (their facing
  if they stand still), standing still, half behind a trunk, facing them.
- Not looked at after about 8 s: one branch crack or run of clicks from its position.
- On being seen: the reveal recording plays then (not at placement). It holds the gaze 2-4 s, head tracking, then
  turns, walks into the fog and is removed out of sight.
- Approached: it backs away faster and never lets the player inside about 12 m.
- Unseen: re-placed closer and more directly ahead about every 20 s until the deadline.

### Encounter 2: the tree
- Head-down on a trunk 15-22 m ahead, near the player's line of travel, staring. Clicks from above before it is noticed.
- On being recognised: holds the stare 2-3 s (head roll, jaw), drops down the trunk fast, lands, rears and roars
  (the quieter hunt-start roar), bluff-charges about 1.5 s toward the player, stops dead, withdraws.
- No suitable tree: it crosses the player's path about 30 m ahead, stops midway, turns its head to look, carries on.
- Same escalation; deadline 6:00.

### Edge cases
- Player indoors: it waits at the treeline in view of the door; the deadline pauses only while they stay inside.
- After a death and respawn the opening does not replay.

### Free roam after the opening
- Starts 80-120 m away. Hunting is allowed from the end of encounter 2 (rare at first, certain by night), not 20:00.
- Shadows at about 25-30 m in daylight instead of 42 m.
- No long dead air: neither seen nor heard for about 2.5 minutes, it is steered toward the player and makes one
  sound from where it really is. The 30 s gap between presence sounds stays.

### Flashlight stun
Was: an instant stop for 3.2 s, then 2.0, 1.2, 0.8 s, then immune; over four minutes to recharge.

| Phase | First use | What is seen |
|---|---|---|
| Slow to a halt | about 0.8 s | decelerates, hisses, head turns from the light |
| Held | about 2.5 s | recoils, takes a step back |
| Getting going | about 1.5 s | starts at a walk, builds back up to a charge |

- Held phase shrinks per use: 2.5, 1.8, 1.2, 0.7 s, and stops shrinking there (never immune).
- Full strength again after about 90 s out of the beam.
- The beam has to stay on it: leaving it during the held phase releases it 0.6 s later.

### Proof before the owner plays
- A headless player bot that plays whole nights against the real encounter code under several play styles, logs
  everything, and a report that checks the guarantees above over many seeds; used to tune before hand-over.
