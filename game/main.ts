/**
 * The page's entry point (index.html): starts the game in <main id="game">. The engine is loaded as its own chunk so the page
 * shell appears at once. A hot update during development disposes the running game before the new one starts.
 */
const container = document.getElementById('game');
let dispose: (() => void) | undefined;
if (container) void import('./engine').then(({ createGame }) => { dispose = createGame(container); });
import.meta.hot?.dispose(() => { dispose?.(); });
