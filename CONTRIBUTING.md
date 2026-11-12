# Contributing to SILENCE

Use Node.js 22.13 or newer (Node 24 recommended), then run `npm ci` and `npm run dev`.
The game is served at http://localhost:5173. Exported models and textures are included;
Blender is only needed when rebuilding assets.

## Work together

1. Clone the repository. Collaborators with write access can push feature branches;
   other contributors can fork and open pull requests.
2. Start from current main: `git switch main` then `git pull --ff-only`.
3. Create a branch: `git switch -c feature/your-change`.
4. Make and test your changes. Commit source and any regenerated game assets together.
5. Push your branch and open a pull request into main for the other person to review.

Before opening a pull request, run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

For visual changes, include before/after screenshots and check day/night, nearby/distant
views, and mobile performance. For creature changes, check planted feet, obstacle
avoidance, and both encounters using Developer Options in the pause menu.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full map. In short:

- `game/`: all game code. `core/` (loop, settings), `sim/` (rules and simulation, no three.js), `render/` (three.js),
  `audio/`, `ui/`, `dev/`, `data/` (JSON written by the asset pipeline).
- `tests/`: regression tests, in the same folders as the code they test.
- `tools/`: the Blender asset pipeline (`tools/assets/`), the playtest bot and probes (`tools/playtest/`), dev pages.
- `public/`: runtime models, textures, audio and sky environments, served as they are.
- `assets/`: editable Blender sources, art and review captures (not served).

Rebuild a world prop with Blender 5.1, for example:

```sh
blender --background --factory-startup --python tools/assets/world-v2/build.py -- cabin
```

This updates the GLB and `game/data/world-assets.json`. Keep both in the same commit.
Generated intermediate atlases, dependencies, local environment files and build output
should not be committed. Preserve all third-party attribution and only contribute
assets you have permission to redistribute. Contributions to original project content
are accepted under the MIT license.

Pushing to GitHub does not deploy the hosted game automatically.
