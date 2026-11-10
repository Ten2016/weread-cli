import { BASE, initialState } from './session.js';
import { Cache } from './cache.js';
import { loadProgress } from './progress.js';

function normalize(book, inShelf = false) {
  return {
    id: String(book.bookId),
    title: book.title || '未命名书籍',
    author: book.author || '',
    url: book.readerLink || '',
    format: book.format || '',
    inShelf,
  };
}

export class Books {
  constructor(session) {
    this.session = session;
    this.reader = null;
    this.home = null;
    this.current = null;
    this.web = null;
    this.cache = new Cache();
    this.syncTask = null;
    this.syncUid = null;
  }

  async shelf() {
    await this.session.start();
    const state = await this.session.shelfState();
    const shelf = state.shelf;
    const indexes = (shelf.rawIndexes || []).filter(index => index.role === 'book' && index.type === 0);
    const books = new Map((shelf.rawBooks || []).map(book => [String(book.bookId), book]));
    const missing = indexes.map(index => String(index.bookId)).filter(id => !books.has(id));
    for (let offset = 0; offset < missing.length; offset += 100) {
      const data = await this.session.json('/web/shelf/syncBook', {
        method: 'POST',
        data: { bookIds: missing.slice(offset, offset + 100), count: 100, isArchive: null, currentArchiveId: null, loadMore: true },
      });
      for (const book of data.books || []) books.set(String(book.bookId), book);
    }
    return indexes.map(index => books.get(String(index.bookId))).filter(Boolean).map(book => normalize(book, true));
  }

  async search(keyword, cursor = { sid: '', maxIdx: 0 }) {
    await this.session.start();
    const data = await this.session.json('/api/store/search', {
      params: { keyword, scope: 17, maxIdx: cursor.maxIdx, count: 20, sid: cursor.sid },
    });
    const entries = (data.results || []).filter(group => group.scope === 17).flatMap(group => group.books || []);
    const maxIdx = entries.at(-1)?.searchIdx ?? cursor.maxIdx;
    return {
      books: entries.filter(entry => entry.bookInfo?.bookId).map(entry => normalize(entry.bookInfo, Boolean(entry.inshelf))),
      cursor: { sid: data.sid || cursor.sid, maxIdx },
      hasMore: Boolean(data.hasMore) && entries.length > 0 && maxIdx !== cursor.maxIdx,
    };
  }

  async recommendations() {
    await this.session.start(true);
    if (!this.home || this.home.isClosed()) this.home = await this.session.context.newPage();
    await this.home.goto(BASE, { waitUntil: 'domcontentloaded' });
    await this.home.waitForFunction(() => Object.values(window.__NUXT__?.data || {}).some(value => value?.type === 2 && Array.isArray(value.books)));
    const data = await this.home.evaluate(() => Object.values(window.__NUXT__.data).find(value => value?.type === 2 && Array.isArray(value.books)).books);
    return data.filter(book => book.bookId && book.type === 0).map(book => normalize(book));
  }

  async add(book) {
    await this.session.start();
    if (book.inShelf) return;
    const result = await this.session.json('/web/shelf/add', { method: 'POST', data: { bookIds: [book.id] } });
    if (result.succ !== 1) throw new Error('加入书架未成功，请刷新书架确认后重试。');
    book.inShelf = true;
  }

  async closeReader() {
    await this.syncTask;
    if (this.current && this.reader && !this.reader.isClosed()) {
      try { await this.refreshCloud(); } catch { /* 云端不可用时保留已保存的本地章节。 */ }
    }
    await this.cache.pending.catch(() => {});
    const page = this.reader;
    this.reader = null;
    this.current = null;
    this.web = null;
    if (page && !page.isClosed()) await page.close();
  }

  async cached() {
    return this.cache.list(this.session.userId);
  }

  async open(book) {
    await this.closeReader();
    const localBook = (await this.cached()).find(item => item.id === book.id);
    const owner = book.cacheUserId || this.session.userId || localBook?.cacheUserId;
    const cached = await this.cache.get(owner, book.id);
    let metadata;
    if (cached) metadata = { ...cached, book: { ...book, ...cached.book }, userId: owner };
    else {
      await this.ensureWeb(book);
      metadata = { ...this.web, book, userId: this.session.userId };
    }
    const { chapters, cloud, userId } = metadata;
    let saved;
    let warning = '';
    try { saved = await loadProgress(userId, book.id); } catch (error) { warning = error.message; }
    let index = chapters.findIndex(chapter => String(chapter.uid) === String(saved?.chapterUid));
    if (index < 0) index = chapters.findIndex(chapter => String(chapter.uid) === String(cloud?.chapterUid));
    this.current = { book: metadata.book, chapters, cloud, userId, index: Math.max(0, index), warning };
    try {
      return await this.chapter(this.current.index);
    } catch (error) {
      const available = cached ? chapters.findIndex(chapter => cached.content?.[chapter.uid]?.length) : -1;
      if (available >= 0) {
        this.current.warning = '上次阅读的章节尚无可用缓存，已打开本机缓存的章节。';
        return this.chapter(available);
      }
      return { ...this.current, blocks: [], fromCache: false, message: error.message };
    }
  }

  async ensureWeb(book) {
    await this.session.start(true);
    if (this.current && this.current.userId !== this.session.userId) throw new Error('当前登录账号与缓存所属账号不同，请切换账号后获取新章节。');
    if (this.web?.bookId === book.id && this.reader && !this.reader.isClosed()) return;
    if (book.format === 'pdf') throw new Error('首版暂不支持 PDF 正文阅读。');
    if (!book.url) {
      const result = await this.search(book.title);
      book.url = result.books.find(item => item.id === book.id)?.url || '';
    }
    const url = new URL(book.url || BASE, BASE);
    if (url.origin !== BASE || !url.pathname.startsWith('/web/reader/')) {
      throw new Error('这本书暂未取得阅读链接，可从搜索结果进入。');
    }
    book.url = url.href;
    if (this.reader && !this.reader.isClosed()) await this.reader.close();
    this.web = null;
    this.reader = await this.session.context.newPage();
    const response = await this.reader.goto(url.href, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error('阅读页加载失败，请稍后重试。');
    // 网页会改写初始化对象，目录和云端进度只能从原始响应读取。
    const meta = initialState(await response.text()).reader;
    if (meta?.bookInfo?.format === 'pdf') throw new Error('首版暂不支持 PDF 正文阅读。');
    if (!Array.isArray(meta?.chapterInfos) || !meta.chapterInfos.length) {
      throw new Error('未取得书籍目录，请刷新书籍列表后重新打开。');
    }
    const chapters = meta.chapterInfos.map(chapter => ({ uid: chapter.chapterUid, title: chapter.title, level: chapter.level || 1 }));
    const index = chapters.findIndex(chapter => String(chapter.uid) === String(meta.currentChapter?.chapterUid));
    const progress = meta.progress?.book;
    this.web = { bookId: book.id, chapters, index, cloud: progress ? {
      chapterUid: progress.chapterUid, progress: progress.progress, updateTime: progress.updateTime,
    } : null };
    book.inShelf = Boolean(meta.isInShelf);
  }

  async webContent() {
    let capture;
    try {
      await this.reader.waitForFunction(() => window.__terminalReader?.content || window.__terminalReader?.error, null, { timeout: 20000 });
      capture = await this.reader.evaluate(() => window.__terminalReader);
    } catch (error) {
      const reason = error.name === 'TimeoutError'
        ? '等待网页正文 20 秒超时，尚未捕获到排版内容'
        : `读取网页正文失败：${error.message.split('\n')[0]}`;
      let loginError = '';
      try { await this.session.checkLogin({ timeout: 5000 }); } catch (error) { loginError = `；登录校验：${error.message.split('\n')[0]}`; }
      let text = '';
      try { text = await this.reader.locator('body').innerText({ timeout: 2000 }); } catch { /* 页面关闭时保留最初的读取错误。 */ }
      if (/购买后|付费阅读|开通会员|去微信读书 App 阅读/.test(text)) {
        throw new Error(`${reason}；页面出现付费、会员或 App 阅读提示，请在微信读书确认阅读权限${loginError}。`);
      }
      throw new Error(`${reason}${loginError}。可继续翻页或通过 c 选择其他章节。`);
    }
    if (capture.error) throw new Error(`网页正文已到达，但文字提取失败：${capture.error}`);
    return capture.content.blocks;
  }

  async webChapter(uid) {
    const index = this.web.chapters.findIndex(chapter => String(chapter.uid) === String(uid));
    if (index < 0) throw new Error('网页目录中未找到当前章节，请刷新书籍列表。');
    const catalog = this.reader.locator('.readerCatalog_list_item');
    const selected = await catalog.evaluateAll(items => items.findIndex(item => item.classList.contains('readerCatalog_list_item_selected')));
    if (selected === index) {
      this.web.index = index;
      return this.webContent();
    }
    if (!await catalog.first().isVisible()) {
      await this.reader.getByRole('button', { name: '目录', exact: true }).first().click();
    }
    await catalog.first().waitFor({ state: 'visible' });
    if (await catalog.count() !== this.web.chapters.length) {
      throw new Error('网页目录与章节数据不一致，请返回书籍列表重新打开。');
    }
    const alreadySelected = await catalog.nth(index).evaluate(item => item.classList.contains('readerCatalog_list_item_selected'));
    if (!alreadySelected) {
      await this.reader.evaluate(() => {
        window.__terminalReader.content = null;
        window.__terminalReader.error = null;
      });
    }
    await catalog.nth(index).click();
    try {
      await this.reader.waitForFunction(target => Array.from(document.querySelectorAll('.readerCatalog_list_item'))
        .findIndex(item => item.classList.contains('readerCatalog_list_item_selected')) === target, index, { timeout: 15000 });
    } catch (error) {
      throw new Error(`已点击网页目录，但等待选中目标章节失败：${error.message.split('\n')[0]}`);
    }
    this.web.index = index;
    return this.webContent();
  }

  async chapter(index) {
    if (index < 0 || index >= this.current.chapters.length) throw new Error('已经到达书籍边界。');
    const uid = this.current.chapters[index].uid;
    const cached = await this.cache.get(this.current.userId, this.current.book.id);
    let blocks = cached?.content?.[uid];
    const fromCache = Array.isArray(blocks);
    if (!fromCache) {
      await this.syncTask;
      await this.ensureWeb(this.current.book);
      blocks = await this.webChapter(uid);
    }
    this.current = { ...this.current, index, blocks, fromCache };
    if (!fromCache) {
      try { await this.cache.put(this.current); } catch (error) { this.current.warning = `正文已加载，但缓存保存失败：${error.message}`; }
    }
    this.queueSync(uid);
    return this.current;
  }

  queueSync(uid) {
    this.syncUid = uid;
    if (this.syncTask) return;
    this.syncTask = (async () => {
      await this.session.ready;
      if (!this.session.authenticated || this.session.userId !== this.current.userId) {
        this.syncUid = null;
        return;
      }
      while (this.syncUid !== null) {
        const target = this.syncUid;
        this.syncUid = null;
        await this.ensureWeb(this.current.book);
        await this.webChapter(target);
        await this.refreshCloud();
        if (this.current.warning?.startsWith('本地阅读不受影响，网页章节未能更新：')) this.current.warning = '';
      }
    })().catch(error => {
      this.syncUid = null;
      if (this.current) this.current.warning = `本地阅读不受影响，网页章节未能更新：${error.message.split('\n')[0]}`;
    }).finally(() => { this.syncTask = null; });
  }

  async refreshCloud() {
    if (!this.current || !this.session.authenticated || !this.session.context) return;
    const response = await this.session.context.request.get(new URL(this.current.book.url, BASE).href, { timeout: 5000 });
    try {
      if (!response.ok()) return;
      const state = initialState(await response.text());
      if (!state.user?.vid) {
        this.session.authenticated = false;
        return;
      }
      const progress = state.reader?.progress?.book;
      if (progress) {
        this.current.cloud = { chapterUid: progress.chapterUid, progress: progress.progress, updateTime: progress.updateTime };
        await this.cache.put(this.current);
      }
    } finally {
      await response.dispose();
    }
  }
}
