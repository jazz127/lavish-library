import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function createReadFailure(directory) {
  const control = path.join(directory, 'unreadable-files.json');
  const preload = path.join(directory, 'deny-reads.mjs');
  await writeFile(control, '[]');
  await writeFile(preload, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const readFile = fs.readFile;
    fs.readFile = async (file, ...args) => {
      const denied = JSON.parse(await readFile(${JSON.stringify(control)}, 'utf8'));
      if (denied.includes(String(file))) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + file), { code: 'EACCES', path: String(file) });
      }
      return readFile(file, ...args);
    };
    syncBuiltinESMExports();
  `);
  return { preload, setUnreadableFiles: async (files) => {
    await writeFile(`${control}.tmp`, JSON.stringify(files));
    await rename(`${control}.tmp`, control);
  } };
}
