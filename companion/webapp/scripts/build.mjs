import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const webappRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(webappRoot, 'dist');
const typescript = path.join(webappRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const compilerArgs = [
    '--project', path.join(webappRoot, 'tsconfig.json'),
    '--outFile', path.join(dist, 'stream-state.js'),
];

mkdirSync(dist, {recursive: true});
execFileSync(process.execPath, [typescript, ...compilerArgs], {cwd: webappRoot, stdio: 'inherit'});
const bundle = [
    readFileSync(path.join(dist, 'stream-state.js'), 'utf8'),
    readFileSync(path.join(webappRoot, 'src', 'plugin.js'), 'utf8'),
].join('\n');
writeFileSync(path.join(dist, 'main.js'), bundle);
