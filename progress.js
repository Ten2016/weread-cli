import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA = fileURLToPath(new URL('./.data/', import.meta.url));
const FILE = fileURLToPath(new URL('./.data/progress.json', import.meta.url));

async function readAll() {
  try {
    const value = JSON.parse(await readFile(FILE, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('格式不正确');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('本地阅读进度无法读取，原文件已保留。');
  }
}

export async function loadProgress(userId, bookId) {
  const saved = (await readAll())[userId]?.[bookId];
  if (!saved || !['string', 'number'].includes(typeof saved.chapterUid)) return null;
  return { chapterUid: saved.chapterUid, updatedAt: saved.updatedAt };
}

export async function saveProgress(userId, bookId, bookmark) {
  if (!userId || !bookmark) return;
  const all = await readAll();
  all[userId] = { ...all[userId], [bookId]: { chapterUid: bookmark.chapterUid, updatedAt: Date.now() } };
  await mkdir(DATA, { recursive: true, mode: 0o700 });
  await chmod(DATA, 0o700);
  const temporary = `${FILE}.tmp`;
  await writeFile(temporary, JSON.stringify(all), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, FILE);
}
