import { Session } from './session.js';
import { Books } from './books.js';
import { Terminal, paginate, readingText } from './terminal.js';
import { saveProgress } from './progress.js';

const session = new Session();
const books = new Books(session);
const terminal = new Terminal();
const loginLabel = () => session.authenticated ? '已登录' : '未登录';
function readingTitle(reading) {
  const percent = reading.cloud?.progress;
  const progress = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? `${percent}%` : '进度未知';
  return `《${reading.book.title}》 · ${progress} · ${loginLabel()} · ${reading.fromCache ? '使用缓存' : '未使用缓存'}`;
}
const stop = () => {
  terminal.close();
  if (!books.current) void session.close().catch(() => {});
};
terminal.rl.on('SIGINT', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function quit(command) {
  if (command !== 'q') return false;
  terminal.running = false;
  return true;
}

async function catalog(reading) {
  let offset = Math.floor(reading.index / terminal.listSize) * terminal.listSize;
  let message = reading.message || '';
  while (terminal.running) {
    const command = await terminal.ask(() => {
      const entries = reading.chapters.slice(offset, offset + terminal.listSize);
      terminal.screen(readingTitle(reading), entries.map((chapter, i) =>
        `${offset + i + 1}. ${offset + i === reading.index ? '● ' : ''}${chapter.title}`
      ), '输入章节编号进入 · n/p 翻目录 · b 返回 · q 退出', message);
    });
    if (quit(command) || command === 'b') return null;
    message = '';
    if (command === 'n') offset = Math.min(offset + terminal.listSize, Math.max(0, reading.chapters.length - terminal.listSize));
    else if (command === 'p') offset = Math.max(0, offset - terminal.listSize);
    else if (/^\d+$/.test(command) && Number(command) >= 1 && Number(command) <= reading.chapters.length) return Number(command) - 1;
    else message = '请输入有效章节编号。';
  }
  return null;
}

async function read(book) {
  terminal.busy('正在加载书籍…');
  let reading = await books.open(book);
  const userId = reading.userId;
  let position = 0;
  let message = reading.message || '';
  let pages = [];
  let pageIndex = 0;
  let text = '';
  let bookmark = null;
  const updateText = () => {
    text = readingText(reading.blocks) || (reading.message
      ? '[本章正文未加载，可继续翻页或通过 c 选择章节。]'
      : '[网页已返回本目录项，但没有可提取文字，可能为图片扉页。可继续翻页。]');
  };
  updateText();

  async function changeChapter(index, nextPosition) {
    terminal.busy('正在加载章节…');
    try {
      reading = await books.chapter(index);
    } catch (error) {
      reading = { ...reading, index, blocks: [], fromCache: false, message: error.message };
    }
    message = reading.message || '';
    position = nextPosition;
    updateText();
  }

  try {
    while (terminal.running) {
      const command = await terminal.ask(() => {
        const layout = terminal.readingLayout;
        pages = paginate(text, layout.width, layout.height);
        pageIndex = pages.findLastIndex(page => page.start <= position);
        pageIndex = Math.max(0, pageIndex);
        if (!Number.isFinite(position)) position = pages[pageIndex].start;
        const chapter = reading.chapters[reading.index];
        if (chapter && reading.blocks.length && !reading.message) bookmark = { chapterUid: chapter.uid };
        terminal.screen(terminal.showCatalog ? readingTitle(reading) : null,
          terminal.readingLines(reading.chapters, reading.index, pages[pageIndex].lines,
            terminal.showCatalog
              ? `${chapter?.title || '正文'} · ${reading.index + 1}/${reading.chapters.length} 章 · ${pageIndex + 1}/${pages.length} 页`
              : chapter?.title || '正文'),
          `${layout.sidebar ? '编号 跳章 · ' : ''}←/→ 翻页 · 回车/n 下页 · h ${terminal.showCatalog ? '隐藏' : '显示'}目录 · c 完整目录 · a 加书架 · b 返回 · q 退出`, message || reading.warning || '');
      }, { pageKeys: true });
      if (quit(command) || command === 'b') return;
      message = '';
      try {
        if (command === 'h') {
          terminal.showCatalog = !terminal.showCatalog;
        } else if (command === 'a') {
          await books.add(book);
          message = '已在书架中。';
        } else if (command === 'c' || (terminal.readingLayout.sidebar && /^\d+$/.test(command))) {
          const index = command === 'c' ? await catalog(reading) : Number(command) - 1;
          if (index !== null) {
            if (index < 0 || index >= reading.chapters.length) {
              message = '请输入有效章节编号。';
              continue;
            }
            await changeChapter(index, 0);
          }
        } else if (['', 'n', '←'].includes(command)) {
          const direction = command === '←' ? -1 : 1;
          const target = pageIndex + direction;
          if (target >= 0 && target < pages.length) position = pages[target].start;
          else {
            const next = reading.index + direction;
            if (next < 0 || next >= reading.chapters.length) message = direction > 0 ? '已到全书末尾。' : '已到全书开头。';
            else {
              await changeChapter(next, direction > 0 ? 0 : Infinity);
            }
          }
        } else message = '请输入底部提示中的操作。';
      } catch (error) {
        message = error.message;
      }
    }
  } finally {
    try {
      await saveProgress(userId, book.id, bookmark);
    } catch (error) {
      const message = `本地阅读进度保存失败：${error.message}`;
      if (terminal.running) throw new Error(message);
      console.error(message);
    }
  }
}

async function list(kind, keyword = '') {
  let items = [];
  let cursor;
  let hasMore = false;
  let offset = 0;
  let message = '';
  let fromCache = kind === 'cache';
  const title = kind === 'cache' ? '本地缓存' : kind === 'shelf' ? '我的书架' : kind === 'recommend' ? '猜你喜欢' : `搜索：${keyword}`;

  async function load(reset = false) {
    terminal.busy('正在获取书籍…');
    if (kind === 'search') {
      const result = await books.search(keyword, reset ? undefined : cursor);
      const all = reset ? result.books : [...items, ...result.books];
      items = [...new Map(all.map(book => [book.id, book])).values()];
      cursor = result.cursor;
      hasMore = result.hasMore;
    } else if (kind === 'cache') items = await books.cached();
    else if (kind === 'shelf') {
      try {
        items = await books.shelf();
        fromCache = false;
      } catch (error) {
        items = await books.cached();
        if (!items.length) throw error;
        fromCache = true;
        message = '当前使用本地已缓存的书籍列表。';
      }
    } else items = await books.recommendations();
    if (reset) offset = 0;
  }

  await load(true);
  while (terminal.running) {
    const command = await terminal.ask(() => terminal.screen(`${title} · ${loginLabel()} · ${fromCache ? '使用缓存' : '未使用缓存'}`,
      items.length ? items.slice(offset, offset + terminal.listSize).map((book, i) =>
        `${offset + i + 1}. ${book.title}${book.author ? ` — ${book.author}` : ''}${book.inShelf ? ' [书架]' : ''}`
      ) : ['暂无书籍。'],
      '编号 阅读 · a 编号 加书架 · n/p 翻页 · r 刷新 · b 返回 · q 退出', message));
    if (quit(command) || command === 'b') return;
    message = '';
    try {
      if (command === 'r') await load(true);
      else if (command === 'p') offset = Math.max(0, offset - terminal.listSize);
      else if (command === 'n') {
        const next = offset + terminal.listSize;
        if (next >= items.length && hasMore) await load();
        if (next < items.length) offset = next;
        else message = '当前列表已到末尾，可输入 r 刷新。';
      } else {
        const match = /^(a\s+)?(\d+)$/.exec(command);
        const index = match ? Number(match[2]) - 1 : -1;
        if (index < 0 || index >= items.length) message = '请输入有效书籍编号。';
        else if (match[1]) {
          await books.add(items[index]);
          message = '已在书架中。';
        } else {
          try {
            await read(items[index]);
          } finally {
            await books.closeReader();
          }
        }
      }
    } catch (error) {
      message = error.message;
    }
  }
}

let message = '默认后台运行，选择列表后自动使用本地登录态。';
void session.initialize().then(() => terminal.refresh());
try {
  while (terminal.running) {
    const command = await terminal.ask(() => terminal.screen(`微信读书 · ${loginLabel()}`, [
      '1. 我的书架', '2. 猜你喜欢', '3. 搜索书籍', '4. 本地缓存',
    ], '1/2/3/4 进入 · login 手动扫码登录 · logout 退出登录 · q 退出程序', message));
    if (quit(command)) break;
    message = '';
    try {
      if (command === '1') await list('shelf');
      else if (command === '2') await list('recommend');
      else if (command === '4') await list('cache');
      else if (command === '3') {
        const keyword = await terminal.ask(() => terminal.screen('搜索书籍', [], '输入关键词 · b 返回 · q 退出'));
        if (quit(keyword)) break;
        if (keyword && keyword !== 'b') await list('search', keyword);
      } else if (command === 'login') {
        terminal.busy('请扫码并在手机确认；检测成功后自动返回菜单，最长等待三分钟。等待期间无需输入命令。');
        await session.login();
        message = '登录态已保存，后续阅读在后台进行。';
      } else if (command === 'logout') {
        await session.logout();
        message = '本工具的登录态已清除。';
      } else message = '请输入底部提示中的操作。';
    } catch (error) {
      message = error.message;
    }
  }
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  terminal.close();
  try { await session.close(); } catch { console.error('登录态保存或浏览器关闭失败，请检查本地文件权限。'); }
}
