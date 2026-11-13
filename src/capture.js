export function installCapture() {
  if (!location.pathname.startsWith('/web/reader/')) return;

  const capture = (window.__terminalReader = { content: null, error: null });

  const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);
  function text(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || ignored.has(node.tagName)) return '';
    if (node.tagName === 'IMG') return `[图片${node.alt ? `：${node.alt}` : ''}]`;
    if (node.tagName === 'BR') return '\n';
    const value = Array.from(node.childNodes).map(text).join('');
    return /^(P|DIV|LI)$/.test(node.tagName) ? `${value}\n` : value;
  }

  // 排版用的 DOM 随后会被清空，必须在网页赋值时保留当前章内容。
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...descriptor,
    set(html) {
      if (this.classList.contains('preRenderContent') && typeof html === 'string' && html.trim()) {
        capture.content = null;
        capture.error = null;
        try {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('script,style,noscript,svg').forEach((node) => node.remove());
          const selector = 'h1,h2,h3,h4,h5,h6,p,pre,li,blockquote,table,img,figcaption';
          const blocks = Array.from(doc.body.querySelectorAll(selector))
            .filter((node) => !node.parentElement.closest(selector))
            .flatMap((node) => {
              if (node.tagName === 'PRE') return { type: 'code', text: node.textContent.replace(/^\n|\n$/g, '') };
              if (node.tagName === 'TABLE') {
                const table = {
                  type: 'table',
                  text: Array.from(node.rows)
                    .map((row) =>
                      Array.from(row.cells)
                        .map((cell) => text(cell).replace(/\s+/g, ' ').trim())
                        .join(' | '),
                    )
                    .join('\n'),
                };
                return node.caption ? [{ type: 'caption', text: text(node.caption).trim() }, table] : table;
              }
              const value = text(node)
                .replace(/[\t\r ]+/g, ' ')
                .trim();
              const type = /^H[1-6]$/.test(node.tagName)
                ? 'heading'
                : node.tagName === 'FIGCAPTION'
                  ? 'caption'
                  : node.tagName === 'IMG'
                    ? 'image'
                    : 'text';
              return { type, text: `${node.tagName === 'LI' ? '• ' : ''}${value}` };
            })
            .filter((block) => block.text.trim());
          if (!blocks.length && doc.body.textContent.trim()) {
            blocks.push({ type: 'text', text: doc.body.textContent.trim() });
          }
          capture.content = { blocks };
        } catch (error) {
          capture.error = `${error.name}: ${error.message.split('\n')[0]}`;
        }
      }
      return descriptor.set.call(this, html);
    },
  });
}
