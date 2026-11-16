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
if (container) void import('./core/engine').then(({ createGame }) => { dispose = createGame(container, loadingHud); });
import.meta.hot?.dispose(() => { dispose?.(); loadingHud?.dispose(); });
