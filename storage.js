import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA = fileURLToPath(new URL('./.data/', import.meta.url));

export async function writeJson(file, value) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
