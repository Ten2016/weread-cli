import { chromium, request } from 'playwright-core';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installCapture } from './capture.js';
import { DATA, writeJson } from './storage.js';

export const BASE = 'https://weread.qq.com';
const AUTH = join(DATA, 'auth.json');

export function initialState(html) {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
  if (!marker) throw new Error('页面数据未返回，请重新登录后重试。');
  const source = html.slice(marker.index + marker[0].length);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(source.slice(0, i + 1));
  }
  throw new Error('无法解析页面数据，网页结构可能已变化。');
}

export class Session {
  browser = null;
  context = null;
  client = null;
  ready = Promise.resolve();
  authenticated = false;
  userId = '';
  closing = null;

  async launch(headless, state) {
    try {
      this.browser = await chromium.launch({ channel: 'chrome', headless });
      this.context = await this.browser.newContext({ storageState: state, viewport: { width: 1600, height: 1000 } });
      this.context.setDefaultTimeout(15000);
      this.context.setDefaultNavigationTimeout(30000);
      await this.context.addInitScript(installCapture);
    } catch {
      await this.browser?.close().catch(() => {});
      this.browser = null;
      this.context = null;
      throw new Error('无法启动后台浏览器，请确认本机已安装 Google Chrome。');
    }
  }

  initialize() {
    this.ready = this.connect().catch(() => {});
    return this.ready;
  }

  async connect() {
    let state;
    try {
      state = JSON.parse(await readFile(AUTH, 'utf8'));
    } catch (error) {
      throw new Error(
        error.code === 'ENOENT' ? '尚未登录，请在主菜单输入 login。' : '登录态文件无法读取，请主动重新登录。',
      );
    }
    this.client = await request.newContext({ storageState: state, timeout: 5000 });
    await this.checkLogin({ timeout: 5000 });
  }

  async start(browser = false) {
    await this.ready;
    if (!this.client && !this.context) await this.connect();
    else if (!this.authenticated) await this.checkLogin({ timeout: 5000 });
    if (browser && !this.context) await this.launch(true, await this.client.storageState());
  }

  async json(path, options = {}) {
    const response = await (this.context?.request || this.client).fetch(`${BASE}${path}`, {
      timeout: 20000,
      ...options,
    });
    try {
      if ([401, 403].includes(response.status())) {
        this.authenticated = false;
        throw new Error('登录已失效，请在主菜单输入 login。');
      }
      if (!response.ok()) throw new Error(`请求失败（HTTP ${response.status()}），请稍后重试。`);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('网页返回了非 JSON 数据，请检查网络或重新登录。');
      }
      const code = data.errcode ?? data.errCode;
      if ([-2010, -2012, -2013].includes(Number(code))) {
        this.authenticated = false;
        throw new Error('登录已失效，请在主菜单输入 login。');
      }
      if (code !== undefined && Number(code) !== 0) {
        throw new Error(`微信读书请求失败（${code}）。`);
      }
      return data;
    } finally {
      await response.dispose();
    }
  }

  async shelfState(options = {}) {
    const response = await (this.context?.request || this.client).get(`${BASE}/web/shelf`, {
      timeout: 20000,
      ...options,
    });
    try {
      if ([401, 403].includes(response.status())) this.authenticated = false;
      if (!response.ok()) throw new Error(`书架加载失败（HTTP ${response.status()}）。`);
      const state = initialState(await response.text());
      const vid = state.user?.vid;
      if (!['string', 'number'].includes(typeof vid) || !vid || vid === '0' || !state.shelf) {
        this.authenticated = false;
        throw new Error('尚未确认登录，请扫码并在手机确认，或在主菜单重新输入 login。');
      }
      return state;
    } finally {
      await response.dispose();
    }
  }

  async checkLogin(options = {}) {
    try {
      const state = await this.shelfState(options);
      this.userId = String(state.user.vid);
      this.authenticated = true;
    } catch (error) {
      this.authenticated = false;
      throw error;
    }
  }

  async save() {
    if ((!this.context && !this.client) || !this.authenticated) return;
    const state = await (this.context || this.client).storageState();
    await writeJson(AUTH, state);
  }

  async login() {
    await this.close();
    await this.launch(false);
    let stage = '加载登录页面';
    try {
      const page = await this.context.newPage();
      await page.goto(`${BASE}/web/shelf`, { waitUntil: 'domcontentloaded' });
      stage = '打开扫码入口';
      const login = page.getByText('登录', { exact: true }).first();
      if (await login.isVisible()) await login.click();
      stage = '等待扫码登录';
      const deadline = Date.now() + 180000;
      let lastError;
      // 网页运行时的 user.vid 可能是对象，改读书架响应中尚未被脚本修改的身份。
      while (true) {
        if (page.isClosed()) throw new Error('登录窗口已关闭。');
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(`三分钟内未确认登录，可重新输入 login。最后一次校验：${lastError?.message || '未登录'}`);
        try {
          await this.checkLogin({ timeout: Math.min(5000, remaining) });
          break;
        } catch (error) {
          lastError = error;
        }
        await delay(Math.min(2000, Math.max(0, deadline - Date.now())));
      }
      stage = '保存登录态';
      await this.save();
    } catch (error) {
      throw new Error(`${stage}失败：${error.message.split('\n')[0]}`);
    } finally {
      await this.close(false);
    }
    await this.connect();
  }

  async logout() {
    await this.close(false);
    await rm(AUTH, { force: true });
    await rm(`${AUTH}.tmp`, { force: true });
    await rm(`${AUTH}.${process.pid}.tmp`, { force: true });
  }

  async close(save = true) {
    await this.ready;
    if (this.closing) return this.closing;
    this.closing = this.closeBrowser(save);
    try {
      await this.closing;
    } finally {
      this.closing = null;
    }
  }

  async closeBrowser(save) {
    try {
      if (save) await this.save();
    } finally {
      const browser = this.browser;
      const client = this.client;
      this.browser = null;
      this.context = null;
      this.client = null;
      this.authenticated = false;
      this.userId = '';
      try {
        await browser?.close();
      } finally {
        await client?.dispose();
      }
    }
  }
}
