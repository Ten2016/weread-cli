import { mkdir, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, writeJson } from './storage.js';

const ROOT = join(DATA, 'cache');
const INDEX = join(ROOT, 'index.json');
const key = (value) => Buffer.from(String(value)).toString('base64url');

async function read(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('本地缓存无法读取，原文件已保留。');
  }
}

export class Cache {
  pending = Promise.resolve();
  loaded = null;

  async list(userId) {
    const index = await read(INDEX, { lastUserId: '', books: {} });
    const owner = userId || index.lastUserId;
    return Object.values(index.books[owner] || {}).map((book) => ({ ...book, cacheUserId: owner }));
  }

  async get(userId, bookId) {
    if (!userId) return null;
    const file = join(ROOT, key(userId), `${key(bookId)}.json`);
    if (this.loaded?.file === file) return this.loaded.value;
    const value = await read(file, null);
    this.loaded = value ? { file, value } : null;
    return value;
  }

  removeChapter(userId, bookId, uid) {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const cached = await this.get(userId, bookId);
        if (!cached?.content || !Object.hasOwn(cached.content, uid)) return;
        const content = { ...cached.content };
        delete content[uid];
        const file = join(ROOT, key(userId), `${key(bookId)}.json`);
        const value = { ...cached, content };
        await writeJson(file, value);
        this.loaded = { file, value };
      });
    this.pending = operation;
    return operation;
  }

  put(reading) {
    const { userId, book, chapters, cloud, index: chapterIndex, blocks } = reading;
    const uid = chapters[chapterIndex]?.uid;
    if (!userId || uid === undefined || !Array.isArray(blocks) || reading.message) return Promise.resolve();
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const directory = join(ROOT, key(userId));
        for (const path of [DATA, ROOT]) {
          await mkdir(path, { recursive: true, mode: 0o700 });
          await chmod(path, 0o700);
        }
        const file = join(directory, `${key(book.id)}.json`);
        const old = await this.get(userId, book.id);
        const metadata = {
          id: book.id,
          title: book.title,
          author: book.author,
          url: book.url,
          format: book.format,
          inShelf: book.inShelf,
          readingProgress: book.readingProgress ?? cloud?.progress ?? null,
        };
        const value = {
          book: metadata,
          chapters,
          cloud,
          content: { ...old?.content, [uid]: blocks.map((block) => ({ type: block.type, text: block.text })) },
        };
        await writeJson(file, value);
        this.loaded = { file, value };
        const catalog = await read(INDEX, { lastUserId: '', books: {} });
        catalog.lastUserId = userId;
        catalog.books[userId] = { ...catalog.books[userId], [book.id]: metadata };
        await writeJson(INDEX, catalog);
      });
    this.pending = operation;
    return operation;
  }
}
