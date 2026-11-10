// Import this first (for its side effect), then dynamically import game modules.
import { register } from 'node:module';
register('./ts-extensionless-hooks.mjs', import.meta.url);
