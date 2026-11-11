import { Session } from './session.js';
import { Books } from './books.js';
import { Terminal, wrapLines, readingText } from './terminal.js';
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

async function read(book) {
  terminal.busy('正在加载书籍…');
  let reading = await books.open(book);
  const userId = reading.userId;
  let position = 0;
  let message = reading.message || '';
  let lines = [];
  let lineIndex = 0;
  let wrappedWidth = 0;
  let text = '';
  let bookmark = null;
  let focus = 'body';
  let selectedChapter = reading.index;
  let catalogOffset = 0;
  const updateText = () => {
    lines = [];
    text = readingText(reading.blocks) || (reading.message
      ? '[本章正文未加载，可继续翻页或切换到目录选择章节。]'
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
    selectedChapter = reading.index;
    updateText();
  }

  try {
    while (terminal.running) {
      const command = await terminal.ask(() => {
        const layout = terminal.readingLayout;
        if (!layout.sidebar) focus = 'body';
        catalogOffset = Math.max(0, Math.min(catalogOffset, selectedChapter, reading.chapters.length - layout.height));
        if (selectedChapter >= catalogOffset + layout.height) catalogOffset = selectedChapter - layout.height + 1;
        if (!lines.length || wrappedWidth !== layout.width) {
          lines = wrapLines(text, layout.width);
          wrappedWidth = layout.width;
        }
        const lastLine = Math.max(0, lines.length - layout.height);
        lineIndex = Math.max(0, Math.min(lastLine, lines.findLastIndex(line => line.start <= position)));
        if (!Number.isFinite(position)) position = lines[lineIndex].start;
        const chapter = reading.chapters[reading.index];
        if (chapter && reading.blocks.length && !reading.message) bookmark = { chapterUid: chapter.uid };
        terminal.screen(terminal.showCatalog ? readingTitle(reading) : null,
          terminal.readingLines(reading.chapters, reading.index, lines.slice(lineIndex, lineIndex + layout.height).map(line => line.text),
            terminal.showCatalog
              ? `${chapter?.title || '正文'} · ${reading.index + 1}/${reading.chapters.length} 章 · ${lineIndex + 1}–${Math.min(lines.length, lineIndex + layout.height)}/${lines.length} 行`
              : chapter?.title || '正文', { focus, selected: selectedChapter, offset: catalogOffset }),
          `${layout.sidebar
            ? `← 目录 / → 正文 · ${focus === 'catalog' ? '↑/↓ 选章 · 回车 打开' : '↑/↓ 翻页 · 回车 下页'}`
            : '←/→ 翻页 · ↑/↓ 滚动 · 回车 下页'} · h ${terminal.showCatalog ? '隐藏' : '显示'}目录 · a 加书架 · b 返回 · q 退出`, message || reading.warning || '');
      }, {
        onArrow: key => {
          if (terminal.readingLayout.sidebar) {
            if (key === 'left' || key === 'right') {
              focus = key === 'left' ? 'catalog' : 'body';
            } else if (focus === 'catalog') {
              const target = Math.max(0, Math.min(reading.chapters.length - 1, selectedChapter + (key === 'down' ? 1 : -1)));
              if (target === selectedChapter) return;
              selectedChapter = target;
            } else return key === 'down' ? '↓' : '↑';
            message = '';
            terminal.refresh();
            return;
          }
          if (key === 'left' || key === 'right') return key === 'right' ? '↓' : '↑';
          const direction = key === 'down' ? 1 : -1;
          const lastLine = Math.max(0, lines.length - terminal.readingLayout.height);
          const target = Math.max(0, Math.min(lastLine, lineIndex + direction));
          if (target === lineIndex) return;
          position = lines[target].start;
          message = '';
          terminal.refresh();
        },
      });
      if (quit(command) || command === 'b') return;
      message = '';
      try {
        if (command === 'h') {
          terminal.showCatalog = !terminal.showCatalog;
        } else if (command === 'a') {
          await books.add(book);
          message = '已在书架中。';
        } else if (command === '' && focus === 'catalog') {
          await changeChapter(selectedChapter, 0);
        } else if (focus === 'body' && ['', '↑', '↓'].includes(command)) {
          const direction = command === '↑' ? -1 : 1;
          const height = terminal.readingLayout.height;
          const lastLine = Math.max(0, lines.length - height);
          const target = Math.max(0, Math.min(lastLine, lineIndex + direction * height));
          if (target !== lineIndex) position = lines[target].start;
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
