import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import stringWidth from 'string-width';
import { Transform, Writable } from 'node:stream';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });
export const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const contentColors = {
  heading: '197;174;235', image: '166;193;155', caption: '211;183;137', table: '154;187;213',
  red: '224;154;172', green: '170;204;151', blue: '158;190;235', cyan: '139;207;202',
};
const sentenceColors = ['red', 'green', 'blue', 'cyan'];
const taskColors = { ...contentColors, heading: '225;205;156', caption: '166;193;155' };
const projectPath = dirname(dirname(fileURLToPath(import.meta.url)));

export function readingContent(blocks) {
  let text = '';
  const styles = [];
  const starts = [];
  for (const [index, block] of blocks.entries()) {
    if (index) text += '\n\n';
    const value = clean(block.text).replace(/\t/g, '    ');
    const start = text.length;
    const styleStart = styles.length;
    starts.push(start);
    let cursor = 0;
    const addStyle = (from, to, type) => {
      if (to > from && Object.hasOwn(contentColors, type)) styles.push({ start: start + from, end: start + to, type });
    };
    for (const match of value.matchAll(/\[图片(?:：[^\]\n]*)?\]/g)) {
      if (block.type === 'code') break;
      addStyle(cursor, match.index, block.type);
      cursor = match.index + match[0].length;
      addStyle(match.index, cursor, 'image');
    }
    addStyle(cursor, value.length, block.type);
    if (block.type === 'text') {
      const protectedStyles = styles.slice(styleStart);
      for (const { segment, index: from } of sentences.segment(value)) {
        if (!segment.trim() || Math.random() >= 0.2) continue;
        const type = sentenceColors[Math.floor(Math.random() * sentenceColors.length)];
        const end = from + segment.length;
        let offset = from;
        for (const style of protectedStyles) {
          if (style.end <= start + offset || style.start >= start + end) continue;
          addStyle(offset, style.start - start, type);
          offset = Math.min(end, style.end - start);
        }
        addStyle(offset, end, type);
      }
    }
    text += value;
  }
  styles.sort((a, b) => a.start - b.start);
  return { text, styles, starts };
}

function renderContent(content, colors = contentColors) {
  if (typeof content === 'string') return clean(content);
  let result = '';
  let cursor = 0;
  for (const style of content.styles || []) {
    result += clean(content.text.slice(cursor, style.start));
    const value = clean(content.text.slice(style.start, style.end));
    result += stdout.isTTY ? `\x1b[38;2;${colors[style.type]}m${value}\x1b[39m` : value;
    cursor = style.end;
  }
  return result + clean(content.text.slice(cursor));
}

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

export function wrapLines(text, width, styles = [], starts = []) {
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
  let styleIndex = 0;
  const blockStarts = new Set(starts);
  for (const line of lines) {
    line.blockStart = blockStarts.has(line.start);
    const end = line.start + line.text.length;
    while (styleIndex < styles.length && styles[styleIndex].end <= line.start) styleIndex++;
    line.styles = [];
    for (let index = styleIndex; index < styles.length && styles[index].start < end; index++) {
      const style = styles[index];
      line.styles.push({ start: Math.max(0, style.start - line.start), end: Math.min(end, style.end) - line.start, type: style.type });
    }
  }
  return lines;
}

export class Terminal {
  constructor() {
    this.inputBar = false;
    this.mouseEnabled = false;
    this.onWheel = null;
    let pending = Buffer.alloc(0);
    let mouseTimer;
    this.input = stdin;
    if (stdin.isTTY && stdout.isTTY) {
      // 鼠标报告先于 readline 消费；保留跨数据块的报告，避免坐标混入命令输入。
      this.input = new Transform({
        transform: (chunk, encoding, done) => {
          clearTimeout(mouseTimer);
          const data = Buffer.concat([pending, chunk]);
          pending = Buffer.alloc(0);
          let offset = 0;
          while (offset < data.length) {
            const escape = data.indexOf(0x1b, offset);
            if (escape < 0) {
              this.input.push(data.subarray(offset));
              break;
            }
            if (escape > offset) this.input.push(data.subarray(offset, escape));
            const rest = data.subarray(escape);
            const value = rest.toString('latin1');
            const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(value);
            const legacy = value.startsWith('\x1b[M');
            if (sgr || (legacy && rest.length >= 6)) {
              const button = sgr ? Number(sgr[1]) : rest[3] - 32;
              if ((!sgr || sgr[4] === 'M') && this.waiting) {
                if (button === 64 || button === 65) this.onWheel?.(button === 64 ? -1 : 1);
              }
              offset = escape + (sgr ? sgr[0].length : 6);
            } else if (value === '\x1b' || value === '\x1b[' || (legacy && rest.length < 6)
              || (rest.length <= 64 && /^\x1b\[<[\d;]*$/.test(value))) {
              pending = rest;
              mouseTimer = setTimeout(() => {
                if (pending.length <= 2) this.input.push(pending);
                pending = Buffer.alloc(0);
              }, pending.length <= 2 ? 50 : 500);
              break;
            } else {
              this.input.push(rest.subarray(0, 1));
              offset = escape + 1;
            }
          }
          done();
        },
        flush: done => {
          clearTimeout(mouseTimer);
          if (pending.length <= 2) this.input.push(pending);
          done();
        },
      });
      this.input.isTTY = true;
      Object.defineProperty(this.input, 'isRaw', { get: () => stdin.isRaw });
      this.input.setRawMode = mode => stdin.setRawMode(mode);
      stdin.pipe(this.input);
    }
    // 灰底输入栏由屏幕定位绘制，readline 只负责编辑，避免长输入换行挤动状态栏。
    const output = stdout.isTTY ? new Writable({
      write: (chunk, encoding, done) => {
        if (!this.inputBar) stdout.write(chunk, encoding);
        done();
      },
    }) : stdout;
    if (output !== stdout) {
      output.isTTY = true;
      Object.defineProperty(output, 'columns', { get: () => stdout.columns });
    }
    this.rl = createInterface({ input: this.input, output, escapeCodeTimeout: 50 });
    this.rl.setPrompt('> ');
    this.running = true;
    this.showCatalog = true;
    this.waiting = false;
    this.redraw = null;
    this.abort = new AbortController();
    this.resize = () => {
      if (output !== stdout) output.emit('resize');
      this.refresh();
    };
    stdout.on('resize', this.resize);
    this.rl.on('close', () => {
      this.setMouse(false);
      clearTimeout(mouseTimer);
      if (this.input !== stdin) {
        stdin.unpipe(this.input);
        stdin.pause();
        this.input.destroy();
      }
      this.running = false;
      this.abort.abort();
    });
  }

  get width() { return Math.max(1, Math.min(160, (stdout.columns || 80) - 2)); }
  get height() { return Math.max(3, (stdout.rows || 28) - 9); }
  get listSize() { return Math.max(3, Math.min(15, this.height)); }

  get readingLayout() {
    const sidebar = this.showCatalog && this.width >= 70 ? Math.min(36, Math.floor(this.width * 0.28)) : 0;
    return {
      sidebar,
      width: Math.max(1, this.width - (sidebar ? sidebar + 3 : !this.showCatalog ? 2 : 0)),
      height: this.showCatalog ? this.height - 1 : Math.max(1, (stdout.rows || 28) - 9),
    };
  }

  readingLines(chapters, index, body, heading = '正文', { focus = 'body', selected = index, offset = 0 } = {}) {
    const { sidebar, height, width } = this.readingLayout;
    const title = { text: fitLine(heading, width), styles: [{ start: 0, end: heading.length, type: 'heading' }] };
    if (!this.showCatalog) return [{ ...title, prefix: '  ' }, ...body.map(line => ({
      ...line,
      prefix: line.blockStart && ['image', 'caption', 'table'].includes(line.styles[0]?.type) ? '└ ' : '  ',
    }))];
    if (!sidebar) return [title, ...body];
    const start = offset;
    const end = Math.min(chapters.length, start + height);
    const readingRow = (label, content) => ({ catalog: fitLine(label, sidebar), body: content, focused: focus === 'catalog' });
    const lines = [readingRow(`目录 ${start + 1}–${end}/${chapters.length}`, title)];
    for (let row = 0; row < height; row++) {
      const chapter = chapters[start + row];
      const indent = chapter ? '  '.repeat(Math.max(0, Math.min(3, (Number(chapter.level) || 1) - 1))) : '';
      const label = chapter ? `${start + row === selected ? '▶' : ' '}${start + row === index ? '●' : ' '} ${start + row + 1}. ${indent}${chapter.title}` : '';
      lines.push(readingRow(label, body[row] || ''));
    }
    return lines;
  }

  screen(title, lines, help, message = '', { startedAt = Date.now() } = {}) {
    this.inputBar = title === null && Boolean(stdout.isTTY) && stdout.rows >= 10;
    this.inputHelp = help;
    if (stdout.isTTY) stdout.write('\x1b[0m\x1b[0 q\x1b[2J\x1b[H');
    if (title !== null) stdout.write(`${clean(title)}\n${'─'.repeat(Math.min(this.width, 70))}\n`);
    const rendered = lines.map(line => {
      if (typeof line === 'string' || !Object.hasOwn(line, 'catalog')) {
        const prefix = line.prefix || '';
        return (stdout.isTTY && prefix ? `\x1b[90m${prefix}\x1b[39m` : prefix)
          + renderContent(line, title === null ? taskColors : contentColors);
      }
      const catalog = clean(line.catalog);
      const highlighted = stdout.isTTY && line.focused
        ? `\x1b[48;2;40;62;44m${catalog}\x1b[49m` : catalog;
      return `${highlighted} │ ${renderContent(line.body)}`;
    });
    if (this.inputBar) {
      stdout.write(rendered.join('\n'));
      const path = projectPath === homedir() ? '~' : projectPath.startsWith(`${homedir()}/`) ? `~${projectPath.slice(homedir().length)}` : projectPath;
      const status = `  GPT-6-Astra high · ${path} · weread`;
      const value = fitLine(status, this.width);
      const pathStart = '  GPT-6-Astra high · '.length;
      const pathEnd = Math.min(value.length, pathStart + path.length);
      const statusLine = { text: value, styles: [
        { start: 0, end: Math.min(pathStart, value.length), type: 'heading' },
        { start: Math.min(pathStart, value.length), end: pathEnd, type: 'image' },
        { start: pathEnd, end: value.length, type: 'heading' },
      ] };
      const now = new Date();
      const seconds = Math.max(0, Math.floor((now.getTime() - startedAt) / 1000));
      const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      stdout.write(`\x1b[${stdout.rows - 7};1H\x1b[90m${fitLine(message ? `  ${message}` : '', this.width)}`);
      stdout.write(`\x1b[${stdout.rows - 6};1H${fitLine(`  Worked for ${duration} • ${time}`, this.width)}\x1b[39m`);
      stdout.write(`\x1b[${stdout.rows - 1};1H\x1b[1m${renderContent(statusLine, taskColors)}\x1b[22m`);
      stdout.write(`\x1b[${stdout.rows - 3};1H`);
      return;
    }
    stdout.write(`${rendered.join('\n')}\n\n${clean(help)}\n`);
    if (message) stdout.write(`${clean(message)}\n`);
  }

  setMouse(enabled) {
    if (!stdin.isTTY || !stdout.isTTY || this.mouseEnabled === enabled) return;
    stdout.write(enabled ? '\x1b[?1006h\x1b[?1000h' : '\x1b[?1000l\x1b[?1006l');
    this.mouseEnabled = enabled;
  }

  async ask(render, { onArrow = null, onWheel = null } = {}) {
    if (!this.running) return 'q';
    this.redraw = render;
    render();
    this.waiting = true;
    this.onWheel = onWheel;
    this.setMouse(Boolean(onWheel));
    this.drawInput();
    const history = this.rl.history;
    let escaped = false;
    // 阅读时暂停命令历史，避免上下键先被 readline 用于回填命令。
    if (onArrow) this.rl.history = [];
    const onKey = (_, key) => {
      if (!this.waiting || !key) return;
      if (key.name === 'escape') {
        escaped = true;
        this.waiting = false;
        this.rl.write(null, { name: 'u', ctrl: true });
        this.rl.write(null, { name: 'k', ctrl: true });
        this.rl.write('\n');
        return;
      }
      if (key.ctrl || key.meta || key.shift) return;
      if (!onArrow || this.rl.line || !['left', 'right', 'up', 'down'].includes(key.name)) return;
      const command = onArrow(key.name);
      if (!command) return;
      this.waiting = false;
      this.rl.write(`${command}\n`);
    };
    if (stdin.isTTY) this.input.on('keypress', onKey);
    const onInput = () => { if (this.waiting) this.drawInput(); };
    if (stdin.isTTY) this.input.on('keypress', onInput);
    try {
      const answer = await this.rl.question(this.inputBar ? '› ' : '> ', { signal: this.abort.signal });
      const command = escaped ? '\x1b' : answer.trim();
      if (command === 'q') this.running = false;
      return command;
    } catch (error) {
      if (!this.running || error.name === 'AbortError' || error.code === 'ERR_USE_AFTER_CLOSE') return 'q';
      throw error;
    } finally {
      this.setMouse(false);
      this.onWheel = null;
      if (stdin.isTTY) this.input.off('keypress', onKey);
      if (stdin.isTTY) this.input.off('keypress', onInput);
      if (onArrow) this.rl.history = history;
      this.waiting = false;
      this.redraw = null;
      if (this.inputBar) {
        stdout.write(`\x1b[0m\x1b[0 q\x1b[${stdout.rows};1H\n`);
        this.inputBar = false;
      }
    }
  }

  drawInput() {
    if (!this.inputBar) return;
    const before = Array.from(segments.segment(clean(this.rl.line.slice(0, this.rl.cursor))));
    let visible = '';
    let columns = 0;
    for (const { segment } of before.reverse()) {
      const size = stringWidth(segment);
      if (columns + size > Math.max(0, this.width - 3)) break;
      visible = segment + visible;
      columns += size;
    }
    const empty = !this.rl.line;
    const value = empty ? 'Ask Codex to do anything' : `${visible}${this.rl.line.slice(this.rl.cursor)}`;
    const text = fitLine(`› ${value}`, this.width);
    const input = `\x1b[1;37m${text.slice(0, 2)}${empty ? '\x1b[22;90m' : ''}${text.slice(2)}`;
    const padding = ' '.repeat(this.width);
    stdout.write(`\x1b[48;2;32;32;32m\x1b[${stdout.rows - 4};1H${padding}\x1b[${stdout.rows - 3};1H${input}\x1b[${stdout.rows - 2};1H${padding}\x1b[0m`);
    stdout.write(`\x1b[${stdout.rows};1H\x1b[90m${fitLine(empty ? `  ${this.inputHelp}` : '', this.width)}\x1b[39m`);
    stdout.write(`\x1b[3 q\x1b[${stdout.rows - 3};${Math.min(this.width, columns + 3)}H`);
  }

  busy(message) { stdout.write(`${clean(message)}\n`); }

  refresh() {
    if (this.waiting && this.redraw) {
      this.redraw();
      this.rl.prompt(true);
      this.drawInput();
    }
  }

  close() {
    stdout.off('resize', this.resize);
    this.rl.close();
  }
}
