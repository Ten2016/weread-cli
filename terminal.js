import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import stringWidth from 'string-width';

const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const readingText = blocks => clean(blocks.map(block => block.text).join('\n\n')).replace(/\t/g, '    ');

function fitLine(value, width) {
  const text = clean(value).replace(/[\n\t]/g, ' ');
  if (stringWidth(text) <= width) return text + ' '.repeat(width - stringWidth(text));
  let result = '';
  let columns = 0;
  for (const { segment } of segments.segment(text)) {
    const size = stringWidth(segment);
    if (columns + size > width - 1) break;
    result += segment;
    columns += size;
  }
  return result + '…' + ' '.repeat(Math.max(0, width - columns - 1));
}

export function paginate(text, width, height) {
  const lines = [];
  let line = '';
  let columns = 0;
  let start = 0;
  for (const { segment, index } of segments.segment(text)) {
    if (segment === '\n') {
      lines.push({ text: line, start });
      line = '';
      columns = 0;
      start = index + segment.length;
      continue;
    }
    const size = stringWidth(segment);
    if (columns + size > width && line) {
      lines.push({ text: line, start });
      line = '';
      columns = 0;
      start = index;
    }
    line += segment;
    columns += size;
  }
  if (line || !lines.length) lines.push({ text: line, start });
  const pages = [];
  for (let i = 0; i < lines.length; i += height) {
    pages.push({ start: lines[i].start, lines: lines.slice(i, i + height).map(item => item.text) });
  }
  return pages;
}

export class Terminal {
  constructor() {
    this.rl = createInterface({ input: stdin, output: stdout });
    this.rl.setPrompt('> ');
    this.running = true;
    this.showCatalog = true;
    this.waiting = false;
    this.redraw = null;
    this.abort = new AbortController();
    this.resize = () => this.refresh();
    stdout.on('resize', this.resize);
    this.rl.on('close', () => {
      this.running = false;
      this.abort.abort();
    });
  }

  get width() { return Math.max(10, Math.min(160, (stdout.columns || 80) - 2)); }
  get height() { return Math.max(3, Math.min(34, (stdout.rows || 28) - 9)); }
  get listSize() { return Math.max(3, Math.min(15, this.height)); }

  get readingLayout() {
    const sidebar = this.showCatalog && this.width >= 70 ? Math.min(36, Math.floor(this.width * 0.28)) : 0;
    return { sidebar, width: this.width - (sidebar ? sidebar + 3 : 0), height: this.height - 1 };
  }

  readingLines(chapters, index, body, heading = '正文') {
    const { sidebar, height, width } = this.readingLayout;
    if (!sidebar) return [fitLine(heading, width), ...body];
    const start = Math.max(0, Math.min(index - Math.floor(height / 2), chapters.length - height));
    const end = Math.min(chapters.length, start + height);
    const lines = [`${fitLine(`目录 ${start + 1}–${end}/${chapters.length}`, sidebar)} │ ${fitLine(heading, width)}`];
    for (let row = 0; row < height; row++) {
      const chapter = chapters[start + row];
      const indent = chapter ? '  '.repeat(Math.max(0, Math.min(3, (Number(chapter.level) || 1) - 1))) : '';
      const label = chapter ? `${start + row === index ? '▶ ' : '  '}${start + row + 1}. ${indent}${chapter.title}` : '';
      lines.push(`${fitLine(label, sidebar)} │ ${body[row] || ''}`);
    }
    return lines;
  }

  screen(title, lines, help, message = '') {
    if (stdout.isTTY) stdout.write('\x1b[2J\x1b[H');
    if (title !== null) stdout.write(`${clean(title)}\n${'─'.repeat(Math.min(this.width, 70))}\n`);
    stdout.write(`${lines.map(clean).join('\n')}\n\n${clean(help)}\n`);
    if (message) stdout.write(`${clean(message)}\n`);
  }

  async ask(render, { pageKeys = false } = {}) {
    if (!this.running) return 'q';
    this.redraw = render;
    render();
    this.waiting = true;
    const onKey = (_, key) => {
      if (!this.waiting || this.rl.line || !key || key.ctrl || key.meta || key.shift) return;
      if (key.name !== 'left' && key.name !== 'right') return;
      this.waiting = false;
      this.rl.write(key.name === 'right' ? 'n\n' : '←\n');
    };
    if (pageKeys && stdin.isTTY) stdin.on('keypress', onKey);
    try {
      const answer = await this.rl.question('> ', { signal: this.abort.signal });
      return answer.trim();
    } catch (error) {
      if (!this.running || error.name === 'AbortError' || error.code === 'ERR_USE_AFTER_CLOSE') return 'q';
      throw error;
    } finally {
      if (pageKeys && stdin.isTTY) stdin.off('keypress', onKey);
      this.waiting = false;
      this.redraw = null;
    }
  }

  busy(message) { stdout.write(`${clean(message)}\n`); }

  refresh() {
    if (this.waiting && this.redraw) {
      this.redraw();
      this.rl.prompt(true);
    }
  }

  close() {
    stdout.off('resize', this.resize);
    this.rl.close();
  }
}
