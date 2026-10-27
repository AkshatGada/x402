import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(resolve('package.json'));
const { build } = require('tsup');
const configs = (await import(pathToFileURL(resolve('tsup.config.ts')))).default;
// ESM + its declaration worker, then CJS; at most two build jobs at once.
for (const config of configs) await build({ ...config, config: false });
await import(pathToFileURL(resolve(process.argv[2])));
