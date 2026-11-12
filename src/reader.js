import { wrapLines, readingContent } from './terminal.js';
import { saveProgress } from './progress.js';

function readingTitle(reading, authenticated) {
  const percent = reading.cloud?.progress;
  const progress = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? `${percent}%` : '进度未知';
  return `《${reading.book.title}》 · ${progress} · ${authenticated ? '已登录' : '未登录'} · ${reading.fromCache ? '使用缓存' : '未使用缓存'}`;
}

export async function readBook(book, books, terminal) {
  const startedAt = Date.now();
  terminal.busy('正在加载书籍…');
  let reading = await books.open(book);
  const userId = reading.userId;
  let position = reading.position ?? 0;
  let message = reading.message || '';
  let showHelp = false;
  let lines = [];
  let lineIndex = 0;
  let wrappedWidth = 0;
  let content;
  let bookmark = null;
  let focus = 'body';
  let selectedChapter = reading.index;
  let catalogOffset = 0;
  const updateContent = () => {
    lines = [];
    content = readingContent(reading.blocks);
    content.text ||= (reading.message
      ? '[本章正文未加载，可继续翻页或切换到目录选择章节。]'
      : '[网页已返回本目录项，但没有可提取文字，可能为图片扉页。可继续翻页。]');
  };
  updateContent();

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
    updateContent();
  }

  function moveBody(offset) {
    const lastLine = Math.max(0, lines.length - terminal.readingLayout.height);
    const target = Math.max(0, Math.min(lastLine, lineIndex + offset));
    if (target === lineIndex) return false;
    position = lines[target].start;
    return true;
  }

  function scrollBody(direction) {
    if (!moveBody(direction)) return;
    message = '';
    terminal.refresh();
  }

  function render() {
    const layout = terminal.readingLayout;
    if (!layout.sidebar) focus = 'body';
    catalogOffset = Math.max(0, Math.min(catalogOffset, selectedChapter, reading.chapters.length - layout.height));
    if (selectedChapter >= catalogOffset + layout.height) catalogOffset = selectedChapter - layout.height + 1;
    if (!lines.length || wrappedWidth !== layout.width) {
      lines = wrapLines(content.text, layout.width, content.styles, content.starts);
      wrappedWidth = layout.width;
    }
    const lastLine = Math.max(0, lines.length - layout.height);
    lineIndex = Math.max(0, Math.min(lastLine, lines.findLastIndex(line => line.start <= position)));
    if (!Number.isFinite(position)) position = lines[lineIndex].start;
    const chapter = reading.chapters[reading.index];
    if (chapter && reading.blocks.length && !reading.message) bookmark = { chapterUid: chapter.uid, position: lines[lineIndex].start };
    const title = chapter?.title || '正文';
    const heading = terminal.showCatalog
      ? `${title} · ${reading.index + 1}/${reading.chapters.length} 章 · ${lineIndex + 1}–${Math.min(lines.length, lineIndex + layout.height)}/${lines.length} 行`
      : title;
    let help = '← for agents · ? for shortcuts';
    if (terminal.showCatalog) {
      const navigation = layout.sidebar
        ? `← 目录 / → 正文 · ${focus === 'catalog' ? '↑/↓ 选章 · 回车 打开' : '↑/↓ 翻页'}`
        : '←/→ 翻页 · ↑/↓ 滚动';
      help = `${navigation} · h 隐藏目录 · r 刷新本章 · a 加书架 · Esc 返回 · q 退出`;
    } else if (showHelp) help = '←/→ 翻页 ↑/↓ 滚动 h 目录 r 刷新本章 a 书架 Esc 返回 q 退出';
    terminal.screen(terminal.showCatalog ? readingTitle(reading, books.session.authenticated) : null,
      terminal.readingLines(reading.chapters, reading.index, lines.slice(lineIndex, lineIndex + layout.height),
        heading, { focus, selected: selectedChapter, offset: catalogOffset }),
      help, message || reading.warning || '', { startedAt });
  }

  function onArrow(key) {
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
    scrollBody(key === 'down' ? 1 : -1);
  }

  try {
    while (terminal.running) {
      const command = await terminal.ask(render, { onArrow, onWheel: scrollBody });
      if (command === 'q' || command === '\x1b') return;
      message = '';
      try {
        if (command === 'h') {
          terminal.showCatalog = !terminal.showCatalog;
        } else if (command === '?') {
          showHelp = !showHelp;
        } else if (command === 'a') {
          await books.add(book);
          message = '已在书架中。';
        } else if (command === 'r') {
          terminal.busy('正在清除本章缓存并重新加载…');
          reading = await books.chapter(reading.index, { refresh: true });
          updateContent();
          message = reading.warning || '本章已从网页重新加载。';
        } else if (command === '') {
          if (focus === 'catalog') await changeChapter(selectedChapter, 0);
        } else if (focus === 'body' && ['↑', '↓'].includes(command)) {
          const direction = command === '↑' ? -1 : 1;
          if (!moveBody(direction * terminal.readingLayout.height)) {
            const next = reading.index + direction;
            if (next < 0 || next >= reading.chapters.length) message = direction > 0 ? '已到全书末尾。' : '已到全书开头。';
            else {
              await changeChapter(next, direction > 0 ? 0 : Infinity);
            }
          }
        } else message = '请输入底部提示中的操作。';
      } catch (error) {
        message = command === 'r' ? `本章刷新失败，保留当前显示内容：${error.message}` : error.message;
      }
    }
  } finally {
    const errors = [];
    try {
      await saveProgress(userId, book.id, bookmark);
    } catch (error) {
      errors.push(`本地阅读进度保存失败：${error.message}`);
    }
    if (bookmark) {
      try {
        await books.syncOnExit(bookmark.chapterUid);
      } catch (error) {
        errors.push(`网页章节同步失败${errors.length ? '' : '，本地进度已保存'}：${error.message.split('\n')[0]}`);
      }
    }
    if (errors.length) {
      const message = errors.join('\n');
      if (terminal.running) throw new Error(message);
      console.error(message);
    }
  }
}
