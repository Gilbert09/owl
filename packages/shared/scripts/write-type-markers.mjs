import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Node decides whether a .js file is ESM or CJS from the nearest package.json
 * `type`. This package's own package.json has no `type` (so: commonjs), which
 * would make dist/esm/*.js get parsed as CommonJS and throw on `import`.
 * A one-key package.json in each output directory pins the format.
 */
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

for (const [dir, type] of [
  ['cjs', 'commonjs'],
  ['esm', 'module'],
]) {
  const target = join(dist, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}
