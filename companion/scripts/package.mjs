import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'build', 'package');
const artifact = path.join(root, 'build', 'openclaw-stream-0.3.0.tar.gz');
const targets = [
    ['linux', 'amd64', 'plugin-linux-amd64'],
    ['linux', 'arm64', 'plugin-linux-arm64'],
    ['darwin', 'amd64', 'plugin-darwin-amd64'],
    ['darwin', 'arm64', 'plugin-darwin-arm64'],
];

execFileSync('npm', ['run', 'build'], {cwd: path.join(root, 'webapp'), stdio: 'inherit'});

rmSync(packageRoot, {recursive: true, force: true});
mkdirSync(path.join(packageRoot, 'server', 'dist'), {recursive: true});
mkdirSync(path.join(packageRoot, 'webapp', 'dist'), {recursive: true});
copyFileSync(path.join(root, 'plugin.json'), path.join(packageRoot, 'plugin.json'));
copyFileSync(path.join(root, 'webapp', 'dist', 'main.js'), path.join(packageRoot, 'webapp', 'dist', 'main.js'));

for (const [goos, goarch, filename] of targets) {
    execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(packageRoot, 'server', 'dist', filename), './server'], {
        cwd: root,
        env: {...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch},
        stdio: 'inherit',
    });
}

mkdirSync(path.dirname(artifact), {recursive: true});
execFileSync('tar', ['-czf', artifact, '-C', packageRoot, '.'], {cwd: root, stdio: 'inherit'});
process.stdout.write(`${artifact}\n`);
