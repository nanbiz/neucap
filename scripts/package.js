// Writes dist/neucap-<version>.zip from the assembled folder (scripts/assemble.sh dist/neucap), its
// files at the zip's top level as the browser loads them unpacked.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const folder = join(root, 'dist', 'neucap');
const archive = join(root, 'dist', `neucap-${version}.zip`);
rmSync(archive, { force: true });
execFileSync('zip', ['-r', '-X', '-q', archive, '.'], { cwd: folder, stdio: 'inherit' });
console.log(archive);
