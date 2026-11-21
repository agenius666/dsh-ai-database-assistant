/**
 * Public-source verification for the published snapshot.
 *
 * Checks install/entry/syntax/packaging prerequisites only. The full regression
 * suite lives in the private development repository and is not part of this
 * public source tree.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const skip = new Set(['node_modules', '.git']);
function walk(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    if (skip.has(entry.name)) return [];
    const target = join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const jsFiles = walk(root).filter((file) => file.endsWith('.js'));
for (const file of jsFiles) {
  const checked = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  if (checked.status !== 0) {
    console.error(`syntax failure: ${file}`);
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== '1.0.3') throw new Error(`unexpected version: ${pkg.version}`);
if (pkg.engines?.node !== '>=22.0.0') throw new Error('unexpected engines.node');
const tedious = JSON.parse(readFileSync(join(root, 'node_modules/tedious/package.json'), 'utf8'));
if (tedious.version !== '20.3.9') throw new Error(`unexpected tedious: ${tedious.version}`);

const host = await import(pathToFileURL(join(root, 'index.js')).href);
if (host.PLUGIN_VERSION !== '1.0.3') throw new Error(`unexpected PLUGIN_VERSION: ${host.PLUGIN_VERSION}`);
await import(pathToFileURL(join(root, 'routes.js')).href);
await import(pathToFileURL(join(root, 'tools.js')).href);
console.log(`public source verification passed: ${jsFiles.length} JavaScript files, version ${pkg.version}, tedious ${tedious.version}`);
