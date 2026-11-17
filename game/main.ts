/**
 * The page's entry point (index.html): starts the game in <main id="game">. The engine is loaded as its own chunk so the page
 * shell appears at once. The loading corner is made here, before that chunk arrives, so even the wait for the code says something;
 * the engine takes it over from there. A hot update during development disposes the running game before the new one starts.
 */
import { createLoadingHud } from './ui/loading-hud';

const container = document.getElementById('game');
let dispose: (() => void) | undefined;
const loadingHud = container ? createLoadingHud(container) : undefined;
loadingHud?.update({ fraction: 0, label: 'Loading the game' }, performance.now());
// Development: ?gl-trace times the WebGL calls that can stall, from before the engine exists (game/dev/gl-trace.ts).
const trace = import.meta.env.DEV && new URLSearchParams(location.search).has('gl-trace') ? import('./dev/gl-trace').then(m => m.installGlTrace()) : Promise.resolve();
let disposed = false;
// createGame builds the world in stages (it yields to paint the loading corner), so it hands back its dispose when it is done.
if (container) void trace.then(() => import('./core/engine')).then(({ createGame }) => createGame(container, loadingHud)).then(d => { if (disposed) d(); else dispose = d; });
import.meta.hot?.dispose(() => { disposed = true; dispose?.(); loadingHud?.dispose(); });
