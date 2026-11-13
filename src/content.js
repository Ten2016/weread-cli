import stringWidth from 'string-width';

export const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });
const blockStyles = new Set(['heading', 'image', 'caption', 'table']);
const sentenceColors = ['red', 'green', 'blue', 'cyan'];
export const clean = (value) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export function readingContent(blocks) {
  let text = '';
  const styles = [];
  const starts = [];
  const sentenceRanges = [];
  let group = 0;
  for (const [index, block] of blocks.entries()) {
    if (index) text += '\n\n';
    const value = clean(block.text).replace(/\t/g, '    ');
    const start = text.length;
    starts.push(start);
    let cursor = 0;
    const addStyle = (from, to, type) => {
      if (to > from && blockStyles.has(type)) styles.push({ start: start + from, end: start + to, type });
    };
    for (const match of value.matchAll(/\[图片(?:：[^\]\n]*)?\]/g)) {
      if (block.type === 'code') break;
      addStyle(cursor, match.index, block.type);
      cursor = match.index + match[0].length;
      addStyle(match.index, cursor, 'image');
    }
    addStyle(cursor, value.length, block.type);
    if (block.type === 'text') {
      for (const { segment, index: from } of sentences.segment(value)) {
        if (!segment.trim()) continue;
        sentenceRanges.push({
          start: start + from + segment.length - segment.trimStart().length,
          end: start + from + segment.length,
          group,
        });
      }
    } else group++;
    text += value;
  }
  styles.sort((a, b) => a.start - b.start);
  return { text, styles, starts, sentenceRanges };
}

export function wrapLines({ text, styles = [], starts = [], sentenceRanges = [] }, width) {
  const lines = [];
  let line = '';
  let columns = 0;
  let start = 0;
  for (const { segment: sentence, index: sentenceStart } of sentences.segment(text)) {
    const sentenceText = sentence.trimEnd();
    const sentenceWidth = stringWidth(sentenceText);
    if (line && columns + sentenceWidth > width) {
      lines.push({ text: line, start });
      line = '';
      columns = 0;
      start = sentenceStart;
    }
    for (const { segment, index: offset } of graphemes.segment(sentence)) {
      const index = sentenceStart + offset;
      if (segment === '\n') {
        lines.push({ text: line, start });
        line = '';
        columns = 0;
        start = index + segment.length;
        continue;
      }
      const size = stringWidth(segment);
      if (columns + size > width && offset >= sentenceText.length) continue;
      if (columns + size > width && line) {
        lines.push({ text: line, start });
        line = '';
        columns = 0;
        start = index;
      }
      line += segment;
      columns += size;
    }
  }
  if (line || !lines.length) lines.push({ text: line, start });
  const lineStarts = new Set(
    lines
      .filter((line) => line.text.trim())
      .map((line) => line.start + line.text.length - line.text.trimStart().length),
  );
  const protectedStyles = styles;
  styles = [...styles];
  let nextSentenceColor = null;
  let group;
  let protectedIndex = 0;
  for (const sentence of sentenceRanges) {
    if (sentence.group !== group) nextSentenceColor = null;
    group = sentence.group;
    let type = nextSentenceColor;
    nextSentenceColor = null;
    if (!type && lineStarts.has(sentence.start)) {
      if (sentence.color === undefined) {
        sentence.color = Math.random() < 0.1 ? sentenceColors[Math.floor(Math.random() * sentenceColors.length)] : null;
      }
      type = sentence.color;
      nextSentenceColor = type;
    }
    if (!type) continue;
    let offset = sentence.start;
    while (protectedIndex < protectedStyles.length && protectedStyles[protectedIndex].end <= offset) protectedIndex++;
    for (
      let index = protectedIndex;
      index < protectedStyles.length && protectedStyles[index].start < sentence.end;
      index++
    ) {
      const style = protectedStyles[index];
      if (style.end <= offset) continue;
      if (style.start > offset) styles.push({ start: offset, end: style.start, type });
      offset = Math.min(sentence.end, style.end);
    }
    if (offset < sentence.end) styles.push({ start: offset, end: sentence.end, type });
  }
  styles.sort((a, b) => a.start - b.start);
  let styleIndex = 0;
  const blockStarts = new Set(starts);
  for (const line of lines) {
    line.blockStart = blockStarts.has(line.start);
    const end = line.start + line.text.length;
    while (styleIndex < styles.length && styles[styleIndex].end <= line.start) styleIndex++;
    line.styles = [];
    for (let index = styleIndex; index < styles.length && styles[index].start < end; index++) {
      const style = styles[index];
      line.styles.push({
        start: Math.max(0, style.start - line.start),
        end: Math.min(end, style.end) - line.start,
        type: style.type,
      });
    }
  }
  return lines;
}
