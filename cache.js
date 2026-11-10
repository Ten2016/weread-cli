import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DATA = fileURLToPath(new URL('./.data/', import.meta.url));
const ROOT = join(DATA, 'cache');
const INDEX = join(ROOT, 'index.json');
const key = value => Buffer.from(String(value)).toString('base64url');

async function read(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('本地缓存无法读取，原文件已保留。');
  }
}

async function write(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

export class Cache {
  pending = Promise.resolve();

  async list(userId) {
    const index = await read(INDEX, { lastUserId: '', books: {} });
    const owner = userId || index.lastUserId;
    return Object.values(index.books[owner] || {}).map(book => ({ ...book, cacheUserId: owner }));
  }

  async get(userId, bookId) {
    if (!userId) return null;
    return read(join(ROOT, key(userId), `${key(bookId)}.json`), null);
  }

  put(reading) {
    const { userId, book, chapters, cloud, index: chapterIndex, blocks } = reading;
    const uid = chapters[chapterIndex]?.uid;
    if (!userId || uid === undefined || !Array.isArray(blocks) || reading.message) return Promise.resolve();
    const operation = this.pending.catch(() => {}).then(async () => {
      const directory = join(ROOT, key(userId));
      for (const path of [DATA, ROOT, directory]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
      }
      const file = join(directory, `${key(book.id)}.json`);
      const old = await read(file, { content: {} });
      const metadata = { id: book.id, title: book.title, author: book.author, url: book.url, format: book.format, inShelf: book.inShelf };
      await write(file, {
        book: metadata, chapters, cloud,
        content: { ...old.content, [uid]: blocks.map(block => ({ type: block.type, text: block.text })) },
      });
      const catalog = await read(INDEX, { lastUserId: '', books: {} });
      catalog.lastUserId = userId;
      catalog.books[userId] = { ...catalog.books[userId], [book.id]: metadata };
      await write(INDEX, catalog);
    });
    this.pending = operation;
    return operation;
  }
}
