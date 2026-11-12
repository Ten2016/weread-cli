import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, writeJson } from './storage.js';

const FILE = join(DATA, 'progress.json');

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

export async function loadReadingTimes(userId) {
  if (!userId) return {};
  const books = (await readAll())[userId] || {};
  return Object.fromEntries(Object.entries(books).map(([id, saved]) => [id, saved?.updatedAt]));
}

export async function saveProgress(userId, bookId, bookmark) {
  if (!userId || !bookmark) return;
  const all = await readAll();
  all[userId] = { ...all[userId], [bookId]: { chapterUid: bookmark.chapterUid, updatedAt: Date.now() } };
  await writeJson(FILE, all);
}
