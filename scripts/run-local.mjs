import { spawn } from 'node:child_process';
import path from 'node:path';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const root = process.cwd();
const bin = path.join(root, 'node_modules', '.bin', 'vinext');
const api = spawn(process.execPath, [path.join(root, 'scripts', 'local-api.mjs')], { stdio: 'inherit' });
const site = spawn(bin, [mode], { stdio: 'inherit' });
let closing = false;

function close(code = 0) {
  if (closing) return;
  closing = true;
  api.kill('SIGTERM');
  site.kill('SIGTERM');
  setTimeout(() => process.exit(code), 100).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close());
api.on('exit', (code) => { if (!closing) close(code || 1); });
site.on('exit', (code) => { if (!closing) close(code || 0); });
