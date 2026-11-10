// Module-loader hooks that let Node import game/*.ts exactly as the bundler
// does: extensionless relative specifiers resolve to .ts, and bare JSON imports
// (no `with { type: 'json' }`) are served as ES modules. Test-only; the game
// sources are never modified.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || error?.code !== 'ERR_MODULE_NOT_FOUND' || /\.[cm]?[jt]s$|\.json$/.test(specifier)) throw error;
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.json') && context.importAttributes?.type !== 'json') {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${text};` };
  }
  return nextLoad(url, context);
}
