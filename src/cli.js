import { Session } from './session.js';
import { Books } from './books.js';
import { Terminal } from './terminal.js';
import { readBook } from './reader.js';
import { loadReadingTimes } from './progress.js';

const session = new Session();
const books = new Books(session);
const terminal = new Terminal();
const loginLabel = () => session.authenticated ? '已登录' : '未登录';
const stop = () => {
  terminal.close();
  if (!books.current) void session.close().catch(() => {});
};
terminal.rl.on('SIGINT', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function list(kind, keyword = '') {
  let items = [];
  let cursor;
  let hasMore = false;
  let offset = 0;
  let selected = 0;
  let readingTimes = {};
  let message = '';
  let fromCache = kind === 'cache';
  const title = kind === 'cache' ? '本地缓存' : kind === 'shelf' ? '我的书架' : kind === 'recommend' ? '猜你喜欢' : `搜索：${keyword}`;

  async function updateReadingTimes() {
    try {
      readingTimes = await loadReadingTimes(items[0]?.cacheUserId || session.userId);
    } catch (error) {
      readingTimes = {};
      message ||= error.message;
    }
  }

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
    if (reset) {
      selected = offset = 0;
      await updateReadingTimes();
    }
  }

  function render() {
    const size = terminal.listSize;
    selected = Math.max(0, Math.min(selected, items.length - 1));
    offset = Math.max(0, Math.min(offset, selected));
    if (selected >= offset + size) offset = selected - size + 1;
    terminal.screen(`${title} · ${loginLabel()} · ${fromCache ? '使用缓存' : '未使用缓存'}`,
      terminal.bookLines(items, selected, offset, readingTimes),
      '↑/↓ 选择 · ←/→ 翻页 · 回车 阅读 · a 加书架 · r 刷新 · Esc 返回 · q 退出', message);
  }

  async function navigate(key) {
    const direction = key === '↑' || key === '←' ? -1 : 1;
    const page = key === '←' || key === '→';
    const size = terminal.listSize;
    const nextOffset = page ? Math.max(0, Math.min(items.length, offset + direction * size)) : offset;
    if (page && nextOffset === offset) return;
    const target = page ? nextOffset + selected - offset : selected + direction;
    const boundary = page ? nextOffset : target;
    const end = page ? nextOffset + size : target + 1;
    while (items.length < end && hasMore) await load();
    if (boundary >= items.length) {
      message = '当前列表已到末尾，可输入 r 刷新。';
      return;
    }
    selected = Math.max(0, Math.min(items.length - 1, target));
    if (page) offset = nextOffset;
  }

  await load(true);
  while (terminal.running) {
    const command = await terminal.ask(render, {
      onArrow: key => ({ up: '↑', down: '↓', left: '←', right: '→' })[key],
    });
    if (command === 'q' || command === '\x1b') return;
    message = '';
    try {
      if (command === 'r') await load(true);
      else if (['↑', '↓', '←', '→'].includes(command)) await navigate(command);
      else {
        const match = /^(a\s+)?(\d+)$/.exec(command);
        const index = command === '' || command === 'a' ? selected : match ? Number(match[2]) - 1 : -1;
        if (index < 0 || index >= items.length) message = '请使用方向键选择书籍，回车阅读，或输入有效书籍编号。';
        else if (command === 'a' || match?.[1]) {
          await books.add(items[index]);
          message = '已在书架中。';
        } else {
          selected = index;
          try {
            await readBook(items[index], books, terminal);
          } finally {
            await books.closeReader();
            await updateReadingTimes();
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
    if (command === 'q') break;
    if (command === '\x1b') continue;
    message = '';
    try {
      if (command === '1') await list('shelf');
      else if (command === '2') await list('recommend');
      else if (command === '4') await list('cache');
      else if (command === '3') {
        const keyword = await terminal.ask(() => terminal.screen('搜索书籍', [], '输入关键词 · Esc 返回 · q 退出'));
        if (keyword === 'q') break;
        if (keyword && keyword !== '\x1b') await list('search', keyword);
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
