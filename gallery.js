/**
 * 通用网页AI阅读助手 —— gallery 对话页面逻辑
 *
 * 职责：
 *   1. 读取会话（正文）与历史对话，渲染 UI
 *   2. 快捷功能 / 自定义提问，多轮对话
 *   3. 通过长连接端口与 background 通信，接收流式回复并打字机渲染
 *   4. API Key 设置弹窗、测试连接、持久化
 *   5. 导出 Markdown、清空对话、复制回答
 */

'use strict';

// ================= 全局状态 =================
const state = {
  sessionId: null,
  session: null,        // {title,url,cleanText,charCount,truncated,fallbackUsed}
  config: null,         // {baseUrl, apiKey, model}
  messages: [],         // [{role, content}]
  streaming: false,
  port: null,
  currentAiBubble: null,
  streamAccumulator: ''
};

// ================= 快捷功能预设 Prompt =================
const QUICK_PROMPTS = {
  summary: '请用简洁流畅的中文，对上述文章内容进行摘要，控制在 200 字以内，突出核心信息与结论。',
  keypoints: '请提取上述文章的核心要点，用分条列点（1. 2. 3.）的形式呈现，每条简洁清晰。',
  translate: '请将上述文章内容完整、准确地翻译成中文，保持原意和段落结构。',
  rewrite: '请对上述文章内容进行改写与润色，使其表达更流畅、更专业、更有条理，同时保持原意不变。'
};

// ================= DOM 引用 =================
const $ = (id) => document.getElementById(id);
const els = {
  sourceTitle: $('source-title'),
  sourceLink: $('source-link'),
  sourceMeta: $('source-meta'),
  chat: $('chat'),
  hint: $('hint'),
  input: $('input'),
  sendBtn: $('btn-send'),
  exportBtn: $('btn-export'),
  clearBtn: $('btn-clear'),
  settingsBtn: $('btn-settings'),
  modal: $('settings-modal'),
  backdrop: $('modal-backdrop'),
  closeModal: $('modal-close'),
  cfgBaseurl: $('cfg-baseurl'),
  cfgApikey: $('cfg-apikey'),
  cfgModel: $('cfg-model'),
  toggleKey: $('btn-toggle-key'),
  testBtn: $('btn-test'),
  saveBtn: $('btn-save'),
  testResult: $('test-result'),
  quickBtns: document.querySelectorAll('.qa-btn')
};

// ================= 打字机效果 =================
const typer = {
  buffer: '',
  shown: 0,
  timer: null,
  target: null,

  setTarget(el) { this.target = el; },

  feed(text) {
    this.buffer += text;
    if (!this.timer) this._start();
  },

  _start() {
    this.timer = setInterval(() => {
      if (!this.target) { this._stop(); return; }
      if (this.shown < this.buffer.length) {
        const step = Math.max(1, Math.ceil((this.buffer.length - this.shown) / 8));
        this.shown += step;
        this.target.textContent = this.buffer.slice(0, this.shown);
        scrollToBottom();
      } else {
        this._stop();
      }
    }, 16);
  },

  _stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },

  finish() {
    this._stop();
    if (this.target) this.target.textContent = this.buffer;
    this.shown = this.buffer.length;
  },

  reset() {
    this._stop();
    this.buffer = '';
    this.shown = 0;
    this.target = null;
  }
};

// ================= 初始化 =================
async function init() {
  state.sessionId = new URLSearchParams(location.search).get('id');
  bindEvents();
  await loadConfig();
  if (state.sessionId) {
    await loadSession();
    await loadChat();
  }
  renderSource();
  renderChat();
  updateControls();
  connectPort();
}

async function loadConfig() {
  const stored = await chrome.storage.local.get('apiConfig');
  state.config = stored.apiConfig || null;
}

async function loadSession() {
  const key = 'session_' + state.sessionId;
  const stored = await chrome.storage.local.get(key);
  state.session = stored[key] || null;
  if (!state.session) state.sessionId = null;
}

async function loadChat() {
  if (!state.sessionId) return;
  const key = 'chat_' + state.sessionId;
  const stored = await chrome.storage.local.get(key);
  state.messages = Array.isArray(stored[key]) ? stored[key] : [];
}

async function persistChat() {
  if (!state.sessionId) return;
  await chrome.storage.local.set({ ['chat_' + state.sessionId]: state.messages });
}

// ================= 渲染 =================

function renderSource() {
  if (!state.session) {
    els.sourceTitle.textContent = '未加载文章';
    els.sourceLink.textContent = '';
    els.sourceLink.href = '#';
    els.sourceLink.style.display = 'none';
    els.sourceMeta.textContent = '';
    return;
  }
  els.sourceTitle.textContent = state.session.title || '未命名文章';
  if (state.session.url) {
    els.sourceLink.textContent = state.session.url;
    els.sourceLink.href = state.session.url;
    els.sourceLink.style.display = 'inline-block';
  } else {
    els.sourceLink.style.display = 'none';
  }
  let meta = `正文 ${state.session.charCount ?? 0} 字`;
  if (state.session.truncated) meta += '（已截断）';
  if (state.session.fallbackUsed) meta += ' · 已降级提取';
  els.sourceMeta.textContent = meta;
}

function renderChat() {
  els.chat.querySelectorAll('.msg').forEach((el) => el.remove());
  if (state.messages.length === 0) {
    showEmptyState(
      state.session
        ? '从上方快捷功能或输入框开始与文章对话'
        : '请先在任意文章页面点击右下角「AI阅读」按钮'
    );
  } else {
    const empty = document.getElementById('empty-state');
    if (empty) empty.remove();
    state.messages.forEach((m) => appendMessage(m.role, m.content, { animate: false }));
  }
  scrollToBottom();
}

function showEmptyState(desc) {
  let empty = document.getElementById('empty-state');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'empty-state';
    empty.className = 'empty-state';
    els.chat.appendChild(empty);
  }
  empty.innerHTML = `<div class="empty-icon">💬</div><p>${desc || ''}</p>`;
}

function appendMessage(role, content, opts = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg ' + role;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  if (opts.streaming) bubble.classList.add('streaming');
  if (opts.error) bubble.classList.add('error');
  wrapper.appendChild(bubble);

  if (role === 'assistant' && opts.copy !== false) {
    wrapper.appendChild(makeCopyBtn(content));
  }

  els.chat.appendChild(wrapper);
  scrollToBottom();
  return bubble;
}

function makeCopyBtn(content) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = '复制';
  btn.title = '复制回答';
  btn.addEventListener('click', async () => {
    const ok = await copyText(content);
    if (ok) {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    }
  });
  return btn;
}

// ================= 事件绑定 =================

function bindEvents() {
  els.quickBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.prompt;
      if (QUICK_PROMPTS[key]) sendChat(QUICK_PROMPTS[key]);
    });
  });

  els.sendBtn.addEventListener('click', () => sendChat(els.input.value));
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(els.input.value);
    }
  });
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px';
  });

  els.exportBtn.addEventListener('click', exportMarkdown);
  els.clearBtn.addEventListener('click', clearChat);
  els.settingsBtn.addEventListener('click', openSettings);
  els.closeModal.addEventListener('click', closeSettings);
  els.backdrop.addEventListener('click', closeSettings);
  els.saveBtn.addEventListener('click', onSaveConfig);
  els.testBtn.addEventListener('click', onTestConnection);
  els.toggleKey.addEventListener('click', toggleKeyVisibility);
}

// ================= 对话发送与流式渲染 =================

async function sendChat(text) {
  text = (text || '').trim();
  if (!text) return;
  if (state.streaming) { toast('上一条回复尚未完成，请稍候'); return; }
  if (!state.session) { toast('请先在文章页面点击「AI阅读」按钮'); return; }
  if (!state.config || !state.config.apiKey) { toast('请先在设置中配置 API Key'); return; }
  if (!state.port) { toast('后台连接尚未就绪，请稍后重试'); return; }

  const history = state.messages.slice();

  appendMessage('user', text);
  state.messages.push({ role: 'user', content: text });
  await persistChat();

  // 创建流式 AI 气泡
  typer.reset();
  state.currentAiBubble = appendMessage('assistant', '', { streaming: true, copy: false });
  typer.setTarget(state.currentAiBubble);
  state.streamAccumulator = '';
  setLoading(true);

  state.port.postMessage({
    type: 'chat',
    sessionId: state.sessionId,
    history,
    userMessage: text
  });
}

function onPortMessage(msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'chunk':
      state.streamAccumulator += msg.delta || '';
      typer.feed(msg.delta || '');
      break;
    case 'done':
      typer.finish();
      finishAssistant(msg.fullText != null ? msg.fullText : state.streamAccumulator);
      break;
    case 'error':
      typer.reset();
      handleStreamError(msg);
      break;
    case 'testResult':
      handleTestResult(msg);
      break;
    default:
      break;
  }
}

function finishAssistant(fullText) {
  if (state.currentAiBubble) {
    state.currentAiBubble.textContent = fullText;
    state.currentAiBubble.classList.remove('streaming');
    state.currentAiBubble.parentElement.appendChild(makeCopyBtn(fullText));
    state.currentAiBubble = null;
  }
  state.messages.push({ role: 'assistant', content: fullText });
  persistChat();
  setLoading(false);
  state.streamAccumulator = '';
  scrollToBottom();
}

function handleStreamError(msg) {
  setLoading(false);
  const text = '⚠️ ' + (msg.message || '请求失败');
  if (state.currentAiBubble) {
    state.currentAiBubble.textContent = text;
    state.currentAiBubble.classList.remove('streaming');
    state.currentAiBubble.classList.add('error');
    state.currentAiBubble = null;
  } else {
    appendMessage('assistant', text, { error: true });
  }
  state.streamAccumulator = '';
  scrollToBottom();
}

function setLoading(loading) {
  state.streaming = loading;
  const ready = !!(state.config && state.config.apiKey) && !!state.session;
  els.sendBtn.disabled = loading || !ready;
  els.quickBtns.forEach((b) => { b.disabled = loading || !ready; });
}

function updateControls() {
  const hasKey = !!(state.config && state.config.apiKey);
  const hasSession = !!state.session;
  const ready = hasKey && hasSession;
  els.quickBtns.forEach((b) => { b.disabled = !ready; });
  els.sendBtn.disabled = !ready;

  if (!hasKey) showHint('尚未配置 API Key，请点击右上角「设置」完成配置');
  else if (!hasSession) showHint('未加载文章，请先在文章页面点击右下角「AI阅读」按钮');
  else hideHint();
}

function showHint(text) {
  els.hint.textContent = text;
  els.hint.classList.remove('hidden');
}
function hideHint() {
  els.hint.classList.add('hidden');
}

// ================= 端口连接 =================

function connectPort() {
  state.port = chrome.runtime.connect({ name: 'ai-chat' });
  state.port.onMessage.addListener(onPortMessage);
  state.port.onDisconnect.addListener(() => {
    state.port = null;
    if (!document.hidden) setTimeout(connectPort, 800);
  });
}

// ================= 设置 =================

function openSettings() {
  if (state.config) {
    els.cfgBaseurl.value = state.config.baseUrl || '';
    els.cfgApikey.value = state.config.apiKey || '';
    els.cfgModel.value = state.config.model || '';
  } else {
    els.cfgBaseurl.value = 'https://api.openai.com/v1';
    els.cfgApikey.value = '';
    els.cfgModel.value = 'gpt-3.5-turbo';
  }
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
  els.modal.classList.remove('hidden');
}

function closeSettings() {
  els.modal.classList.add('hidden');
}

function toggleKeyVisibility() {
  els.cfgApikey.type = els.cfgApikey.type === 'password' ? 'text' : 'password';
}

function readFormConfig() {
  return {
    baseUrl: els.cfgBaseurl.value.trim(),
    apiKey: els.cfgApikey.value.trim(),
    model: els.cfgModel.value.trim()
  };
}

function validateConfig(cfg) {
  if (!cfg.baseUrl) return '请填写 API 地址';
  try {
    const u = new URL(cfg.baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'API 地址必须是 http(s) 协议';
  } catch (e) {
    return 'API 地址格式不正确';
  }
  if (!cfg.apiKey) return '请填写 API Key';
  if (!cfg.model) return '请填写模型名称';
  return null;
}

async function onSaveConfig() {
  const cfg = readFormConfig();
  const err = validateConfig(cfg);
  if (err) { setTestResult(err, false); return; }

  // 请求接口域名访问权限（必须在用户手势内调用）
  const granted = await requestHostPermission(cfg.baseUrl);
  if (!granted) { setTestResult('未获得接口域名的访问权限，已取消保存', false); return; }

  await chrome.storage.local.set({ apiConfig: cfg });
  state.config = cfg;
  setTestResult('配置已保存', true);
  updateControls();
  setTimeout(closeSettings, 800);
}

async function onTestConnection() {
  const cfg = readFormConfig();
  const err = validateConfig(cfg);
  if (err) { setTestResult(err, false); return; }

  const granted = await requestHostPermission(cfg.baseUrl);
  if (!granted) { setTestResult('未获得接口域名的访问权限，无法测试', false); return; }
  if (!state.port) { setTestResult('后台连接未就绪，请稍后重试', false); return; }

  setTestResult('正在测试连接…', null);
  state.port.postMessage({ type: 'testConnection', config: cfg });
}

function handleTestResult(msg) {
  if (msg.ok) setTestResult('✅ ' + (msg.message || '连接成功'), true);
  else setTestResult('❌ ' + (msg.message || '连接失败'), false);
}

function setTestResult(text, ok) {
  els.testResult.textContent = text;
  els.testResult.className = 'test-result ' + (ok === true ? 'ok' : ok === false ? 'fail' : '');
}

/** 向用户请求某个接口域名的访问权限（host permission） */
function requestHostPermission(baseUrl) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = new URL(baseUrl).origin + '/*';
    } catch (e) {
      resolve(false);
      return;
    }
    try {
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        resolve(!chrome.runtime.lastError && granted);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

// ================= 导出 Markdown =================

function exportMarkdown() {
  const s = state.session;
  const title = (s && s.title) ? s.title : '未命名';

  const lines = [];
  lines.push('# ' + title);
  lines.push('');
  lines.push('- **来源链接**：' + (s && s.url ? s.url : '无'));
  lines.push('- **提取时间**：' + formatTime(new Date()));
  lines.push('- **正文字符数**：' + ((s && s.charCount) || 0) + ((s && s.truncated) ? '（已截断）' : ''));
  lines.push('');
  lines.push('## 原文正文');
  lines.push('');
  lines.push((s && s.cleanText) ? s.cleanText : '（无）');
  lines.push('');
  lines.push('## 对话记录');
  lines.push('');

  if (state.messages.length === 0) {
    lines.push('（暂无对话）');
  } else {
    state.messages.forEach((m) => {
      lines.push(m.role === 'user' ? '### 👤 用户' : '### 🤖 AI');
      lines.push('');
      lines.push(m.content);
      lines.push('');
    });
  }

  const md = lines.join('\n');
  const filename = sanitizeFilename(title) + '_AI阅读笔记_' + timestamp() + '.md';
  downloadTextFile(filename, md);
  toast('已导出 Markdown');
}

async function clearChat() {
  if (state.streaming) { toast('回复生成中，请稍候'); return; }
  state.messages = [];
  await persistChat();
  renderChat();
}

// ================= 工具函数 =================

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function sanitizeFilename(name) {
  return (name || '')
    .replace(/[\\/:*?"<>|#%&{}\[\]]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '未命名';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatTime(d) {
  return d.toLocaleString('zh-CN', { hour12: false });
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

let toastTimer = null;
function toast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ================= 启动 =================
init();
