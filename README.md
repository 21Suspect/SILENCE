# SILENCE

A first-person psychological horror vignette in a dense, fogbound conifer forest. The world has contextual interaction prompts and a fullscreen pause menu; exploration remains in first person. Walk, listen, and allow the light to fade.

## Play

Click anywhere in the forest to capture the mouse and enable audio. Use headphones.

- **W A S D** — walk
- **Mouse** — look
- **Shift** — hurry
- **Control** — crouch
- **E** or **left click** — interact with a nearby object; the flashlight rests on the cabin porch bench
- **Left click** — toggle the flashlight after pickup
- **F2** or **backtick** — developer controls (time, flight, encounters)
- **F** — fullscreen
- **Escape** — pause menu / resume
- **Q** — drop the carried objective item
- **Space** — release a ladder (or fly up in noclip)

Click again to resume. When pointer lock is unavailable in an embedded browser, hold the mouse button and drag to look. On phones, play in portrait. Drag the left side to sprint and the right side to look; there are no visible joysticks. A short stationary tap anywhere picks up or toggles the flashlight. Holds, drags, cancelled touches and multitouch gestures cannot toggle it.

The game begins at 16:00 and completes one day/night cycle every 24 minutes of active play. The original HDR illumination, calibrated blue sky gradient, moving clouds and resolved stars follow the rotating sun. Night retains a small visibility floor. Time and sound pause when the page loses focus. Sightings are rare and intentionally unpredictable, and there is no combat, score, inventory, death screen, or ending.

## Encounters

The first natural encounter is scheduled randomly between 17:30 and 18:30; the second (tree ambush) between 19:30 and 22:00. These use the actual solar clock and follow cycle speed or admin time changes. Failed placements retry every 3–7 seconds within the window. If no safe placement exists before it closes, the encounter waits for the next matching window; visible spawning is never forced. A creature is never introduced, teleported or removed within the protected direct/reflected view. Unseen encounters persist and stalk toward the player’s flank; up to three spaced directional sounds help attract attention. The supplied MP3 plays once when a creature successfully spawns, including offscreen spawns; repositioning and later recognition do not repeat it. Direct unobstructed visibility within 30 m held for 0.18 seconds still controls recognition and retreat. After recognition it retreats, but remains present until safely offscreen. Subsequent encounters wait 110–170 seconds after removal.

The second natural encounter uses a tall tree: it clings head-down 14–20 metres above the ground, with its torso tucked close to the bark, waits for 0.18 seconds of direct unobstructed camera visibility (up to 48 m for the elevated perch), spirals down with world-locked bark contacts, transfers its feet onto the ground in sequence at a steady 1.4 m/s, then immediately accelerates away. The dismount takes about four seconds; airborne feet carry their ongoing steps into the running gait without a planted-foot wait. Tree selection checks for an escape route; failed placement retries rather than substituting a ground spawn. Escape navigation prefers wide, curved paths, then folds the shoulders and leg stance to use centred gaps between trunks when needed. Stalled escapes replan, and approaching within ten metres triggers ground retreat. F2 → Tree ambush tests this encounter without advancing the natural encounter counter.

## Open source

Original project content is MIT licensed. See [third-party notices](THIRD_PARTY_NOTICES.md)
and [contribution guide](CONTRIBUTING.md) for asset licenses and the collaboration workflow.
The supplied reveal recording is included as `public/audio/scary sound.mp3` with
redistribution permission confirmed by the project owner; see the third-party notices.

## Local development

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run dev
```

Open the Local URL printed by Vite. The production build is `npm run build`; `npm start` serves the built Worker locally through Wrangler.

## World and rendering

Three.js renders a streamed mountain basin with deterministic tree placement, terrain-conforming walking, collisions, winding paths, an overgrown road, a running stream, a damaged footbridge, and an abandoned shelter. Instanced vegetation and distance-based geometry keep the world responsive. Scanned PBR bark, mossy rock, weathered timber, and forest-floor materials use local assets. Photographed grass, fern, and pine-shoot assets form the understory and crowns. Tree root edges conform to the exact terrain mesh, while fallen trunks have closed, textured end grain and bark shells. The river uses planar reflections, depth-aware refraction, geometric surface ripples, and a scanned gravel bed with wet bank blending. A depth-aware ray-marched postprocess provides drifting, height-dependent volumetric fog, tree-occluded dawn light shafts, with smooth deterministic sampling. The light shafts sample the directional shadow map, rather than sitting on top of the image, and fade away toward night.

Binaural HRTF forest ambience uses four world-anchored wind/canopy emitters, spatial calls and river audio; turning changes their bearing. The supplied reveal sound is localized at the creature and remains audible at encounter range. Sustained actual sprinting builds head-local breathing after about eight seconds, recovering gradually after stopping. Headphones give the clearest directional cues.

Audio is synthesized locally with Web Audio: wind, needles, forest calls, timber creaks, variable footfalls, and spatial river noise. The user-supplied creature reveal MP3 is served locally with the game. The creature uses an original sculpted, skinned mesh inspired by the supplied silhouette, with articulated head, hands and planted feet. No supplied reference image is redistributed.

Sun shadows use a texel-aligned 4096px map (limited by device capability), filtered edges, and cached depth when the sun is paused. While time advances, the sun direction and its shadows update every rendered frame. Walking recenters the map in whole texels; changes to forest instances and creature motion invalidate the cache. Fog light shafts use a stationary sampling pattern. Soil, gravel, asphalt, stone, bark, and timber blend stochastic texture patches with shared colour/normal/roughness coordinates and explicit mip gradients. Broad weathering variation and independent timber crops break up repeated landmarks while retaining directional wood grain.

The main scene uses adaptive 2×/4× MSAA plus final FXAA. Texture anisotropy uses the device limit. A single requestAnimationFrame loop follows browser/display refresh pacing; driver-level VSync is browser-controlled. The flashlight adds a warm shadowed beam and fog scattering.

The experience requires a WebGL2-capable browser and hardware acceleration. Resolution adapts downward on slower devices. There is no network dependency after the application and its textures load.

Rendering is capped at two million internal pixels and a 1.4 device-pixel ratio before adaptive scaling. Sustained slow frames lower resolution gradually, and sustained spare capacity restores it; isolated loading hitches do not trigger a change. Volumetric integration runs at half width/height with depth-aware optical reconstruction at full resolution. Water uses its own depth-tested layer instead of copying the full opaque colour/depth buffers. Its 768px reflection retains trees, banks and large plants while omitting fine grass and tiny litter. Grass keeps its original placement density with three geometry detail levels; distant crowns simplify only beyond the close range. Shared stone and timber scans avoid duplicate GPU texture uploads.

## Assets

Scanned textures by Poly Haven contributors, available under CC0:

- [Forest Ground 01](https://polyhaven.com/a/forrest_ground_01)
- [Bark Brown 02](https://polyhaven.com/a/bark_brown_02)
- [CC0 license](https://polyhaven.com/license)

Source URLs, original hashes, dimensions, and licenses are in `public/textures/texture-attribution.json` and `public/plantassets/attribution.json`. Botanical meshes and photographed leaf/needle maps are CC0 assets from Poly Haven, with source details in the plant attribution file. Other procedural geometry, sound synthesis, and game code were created for this project.

## Validation

Validated with TypeScript, a production build, and Chromium browser checks. Browser QA covers initial rendering, movement, pause/resume, river and road views, night progression, rare encounter scheduling, viewport changes, an empty visible interface, close-up material inspection, riverbank continuity, and a numerical tree-root grounding audit. Development-only inspection helpers are removed from the production build.

Run the shadow stability regression checks with `node --experimental-strip-types --test tests/stable-shadows.test.mjs`. They check world-locked shadow sampling along hilly routes at two map resolutions and static cache reuse.

Run all rendering regressions with `node --experimental-strip-types --test tests/*.test.mjs`. These also cover pixel-budget limits and adaptation/recovery hysteresis. A local Chromium comparison at 1440×900 CSS pixels and a **fixed 1.5 render ratio** reduced submitted triangles from 7.62M to 4.71M in the starting forest view, and 14.15M to 8.03M beside the river. On the same nine-second walking route, mean frame time improved from 20.56ms to 16.67ms, and the 95th percentile from 33.4ms to 16.7ms. These are one-machine measurements, not a universal frame-rate guarantee. Normal game-update CPU time was around 0.1ms median; most pressure came from rendering. Development-only `record`, `inventory`, and GPU timer-query `benchmark` helpers support repeatable checks; per-pass GPU measurements can vary with GPU scheduling, so paced walking traces are the reported smoothness comparison.

Creature locomotion uses world-space foot contacts, alternating tripod swings, terrain-sampled landing positions and fixed-length inverse kinematics. Breathing, head movement and loose arm motion continue independently of planted feet. Skin uses diffuse, normal and roughness maps; higher-resolution anatomy and tapered muscles retain the original silhouette. Gait regressions cover stance drift, terrain clearance, exact touchdown and bone lengths.

Escape opens the pause menu and freezes the game clock, encounters and audio. The fullscreen Graphics Settings screen offers automatic adaptation, High / Medium / Low presets, and individual controls for render scale, shadow resolution, volumetric fog resolution, water reflection resolution, anti-aliasing, anisotropic filtering and field of view. Individual changes select Custom; available MSAA and anisotropy are capped by the device. VSync is browser-controlled. Developer Options contains the former F2 tools (F2 remains a shortcut to that tab); queued encounters run after resuming. Keybindings supports reassignment, conflict swapping, reset and look sensitivity. Preferences persist in local storage. Touch devices have a small pause button.


## Integrated world v2

The seeded world is now the default (`?seed=7741`); `?classic-world` keeps the original geography. Cabin, relay station, generator, lookout, logging and hunter camps, chapel, mine and road bridge are connected by graded trails. Terrain chunks are generated in a bundled worker. Blender model sources and rebuild scripts live in `scripts/assets/world-v2`; deployable assets are in `public/world`.

Find the camp jerrycan, refuel and pull-start the relay generator, collect fuses from the mine, lookout and logging area, insert all three into the hut fuse box, then transmit. One objective item can be carried at a time. Ladders use forward/backward movement. Touch devices show a contextual Drop / Leave ladder button when needed.

The integration deliberately retains SILENCE's original creature mesh, textures, six-leg articulation, original ambient audio, footsteps, breathing and reveal sound. No new sound runtime or fireflies are included. Silent crows and chimney smoke are included. Noise event records remain available to future gameplay, but are not connected to creature hearing; multiplayer is not implemented.

Graphics settings now also expose water detail and shadow update cadence. Every-frame sun shadows are the default; 30 Hz is optional and used by the Low preset. Existing custom bindings/settings migrate, with a new Drop binding. Menus contain controls and labels without explanatory paragraphs.
