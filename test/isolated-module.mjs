// Run host-module tests against private copies and a private schemastery stub.
// Never create, reuse or remove anything in the repository's node_modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createIsolatedModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepisland-test-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    fs.rmSync(dir, { recursive: true, force: true });
    cleaned = true;
  };
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    for (const file of ['index.js', 'nudge.js', 'browser-api.js', 'bridge-owner.js']) {
      fs.copyFileSync(path.join(ROOT, 'lib', file), path.join(dir, 'lib', file));
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const shim = path.join(dir, 'node_modules', '@deepseek-ai', 'schemastery');
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(shim, 'index.js'), `const node = () => { const s = {}; for (const m of ['default','description','step','min','max','readonly']) s[m] = () => s; return s; };
export default { object: node, union: node, boolean: node, number: node, natural: node, string: node, const: node };
`);
    process.once('exit', cleanup);
    return { dir, cleanup, importModule: (file = 'index.js') => import(pathToFileURL(path.join(dir, 'lib', file)).href) };
  } catch (error) {
    cleanup();
    throw error;
  }
}
