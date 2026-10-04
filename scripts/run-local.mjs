import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadDotenv } from 'vinext/internal/config/dotenv';
import { remoteAccessConfig } from './remote-access.mjs';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const root = process.cwd();
loadDotenv({ root, mode: mode === 'start' ? 'production' : 'development' });
const remoteAccess = remoteAccessConfig();
const bin = path.join(root, 'node_modules', '.bin', 'vinext');
const api = spawn(process.execPath, [path.join(root, 'scripts', 'local-api.mjs')], { stdio: 'inherit' });
const site = spawn(bin, mode === 'start'
  ? [mode, '--hostname', remoteAccess.bindHost, '--port', String(remoteAccess.uiPort)]
  : [mode], { stdio: 'inherit' });
let closing = false;

function close(code = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = code;
  api.kill('SIGTERM');
  site.kill('SIGTERM');
  setTimeout(() => process.exit(code), 100).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close());
api.on('exit', (code) => { if (!closing) close(code || 1); });
site.on('exit', (code) => { if (!closing) close(code || 0); });

function launchFailed(error) {
  console.error(`Could not launch the local app: ${error.message}`);
  close(1);
}
api.on('error', launchFailed);
site.on('error', launchFailed);
