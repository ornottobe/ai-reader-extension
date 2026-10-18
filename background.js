/**
 * 通用网页AI阅读助手 —— 后台 Service Worker
 *
 * 职责：
 *   1. 接收 content script 发来的正文数据，存储并打开 gallery 对话页面
 *   2. 作为 AI 接口代理：读取本地存储的 API 配置，转发请求
 *   3. 支持 SSE 流式返回，逐段回传 gallery 页面
 *   4. 统一异常处理（key 为空 / 401 / 网络错误 / token 超限等），给出中文提示
 *
 * 安全：API Key 仅保存在 chrome.storage.local，绝不下发到 content script；
 *       gallery 页面也无法直接调用大模型接口，所有请求都经由本脚本代理。
 */

'use strict';

const SESSION_PREFIX = 'session_';
const CHAT_PREFIX = 'chat_';
const CONFIG_KEY = 'apiConfig';

// 记录每个端口正在进行的流式请求，用于取消 / 隔离
const activeStreams = new Map(); // key: Port, value: AbortController

// ================= 工具栏图标点击：打开 gallery（无会话） =================
chrome.action.onClicked.addListener(() => {
  openGallery(null);
});

// ================= 消息处理：content script -> background =================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'OPEN_GALLERY') {
    handleOpenGallery(msg.payload)
      .then((sessionId) => sendResponse({ ok: true, sessionId }))
      .catch((err) => sendResponse({ ok: false, message: friendlyError(err) }));
    return true; // 保持异步响应通道
  }
  return false;
});

/** 存储正文并打开 gallery 页面 */
async function handleOpenGallery(payload) {
  const sessionId = genId('s');
  const data = { sessionId, createdAt: Date.now(), ...(payload || {}) };
  await chrome.storage.local.set({ [SESSION_PREFIX + sessionId]: data });
  await cleanupOldSessions();
  await openGallery(sessionId);
  return sessionId;
}

function openGallery(sessionId) {
  const url = sessionId
    ? chrome.runtime.getURL('gallery.html') + '?id=' + sessionId
    : chrome.runtime.getURL('gallery.html');
  return chrome.tabs.create({ url });
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 清理 7 天前的会话及其对话记录，避免 storage 无限膨胀 */
async function cleanupOldSessions() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const toRemove = [];
    for (const key of Object.keys(all)) {
      if (key.startsWith(SESSION_PREFIX)) {
        const v = all[key];
        if (v && v.createdAt && now - v.createdAt > 7 * 24 * 3600 * 1000) {
          toRemove.push(key, CHAT_PREFIX + v.sessionId);
        }
      }
    }
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch (e) {
    /* 忽略清理错误 */
  }
}

// ================= 长连接端口：gallery <-> background =================
// 每个 gallery 标签页会建立一个独立端口，天然实现会话隔离。
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-chat') return;

  port.onMessage.addListener(async (msg) => {
    try {
      await handlePortMessage(port, msg);
    } catch (err) {
      safePost(port, { type: 'error', code: err.code || 'UNKNOWN', message: friendlyError(err) });
    }
  });

  port.onDisconnect.addListener(() => {
    const ctrl = activeStreams.get(port);
    if (ctrl) {
      ctrl.abort();
      activeStreams.delete(port);
    }
  });
});

async function handlePortMessage(port, msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'chat':
      await handleChat(port, msg);
      break;
    case 'abort':
      abortStream(port);
      break;
    case 'testConnection':
      await handleTestConnection(port, msg);
      break;
    default:
      break;
  }
}

// ================= AI 对话（流式） =================

async function handleChat(port, msg) {
  const config = await getApiConfig();
  if (!config || !config.apiKey) {
    throw makeError('NO_KEY', '尚未配置 API Key，请在设置中填写后重试');
  }
  const sessionId = msg.sessionId;
  if (!sessionId) {
    throw makeError('NO_SESSION', '缺少文章上下文，请先在文章页面点击「AI阅读」');
  }

  // 读取正文上下文
  const stored = await chrome.storage.local.get(SESSION_PREFIX + sessionId);
  const session = stored[SESSION_PREFIX + sessionId];
  const context = session ? session.cleanText || '' : '';

  // 组装消息：system（含正文） + 历史 + 本次用户消息
  const systemPrompt = buildSystemPrompt(session, context);
  const history = Array.isArray(msg.history) ? msg.history : [];
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: msg.userMessage }
  ];

  // 取消上一个未完成的流
  abortStream(port);
  const controller = new AbortController();
  activeStreams.set(port, controller);

  try {
    const fullText = await streamChat(port, config, messages, controller.signal);
    safePost(port, { type: 'done', fullText });
  } finally {
    activeStreams.delete(port);
  }
}

function buildSystemPrompt(session, context) {
  const title = session && session.title ? session.title : '未知标题';
  const url = session && session.url ? session.url : '';
  return [
    '你是专业的 AI 阅读助手。用户会提供一篇网页文章，请基于文章内容回答问题。',
    '要求：回答准确、简洁、条理清晰；若用户要求翻译 / 改写 / 摘要，则按要求完成；',
    '如文章内容不足以回答，请如实说明，不要编造。',
    '',
    '【文章标题】' + title,
    '【文章链接】' + url,
    '',
    '【文章正文】',
    context || '（正文为空）'
  ].join('\n');
}

async function getApiConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return stored[CONFIG_KEY] || null;
}

/** 向 OpenAI 兼容接口发起流式请求，逐段回传 */
async function streamChat(port, config, messages, signal) {
  const endpoint = buildEndpoint(config.baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + config.apiKey
  };

  let res;
  try {
    res = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model || 'gpt-3.5-turbo',
        messages,
        stream: true,
        temperature: 0.7
      }),
      signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw makeError('ABORTED', '已取消');
    throw makeError('NETWORK', '网络错误：无法连接 API 地址，请检查接口地址或网络');
  }

  if (!res.ok) {
    await throwHttpError(res);
  }

  const contentType = res.headers.get('content-type') || '';

  // 判断是否真正的 SSE 流式响应
  if (contentType.includes('text/event-stream')) {
    return await readSseStream(port, res, signal);
  }

  // 非流式兜底：一次性读取完整 JSON 响应
  const json = await res.json().catch(() => null);
  const content =
    json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : '';
  const fullText = content || '';
  if (fullText) safePost(port, { type: 'chunk', delta: fullText });
  return fullText;
}

/** 读取 SSE 流：解析 "data:" 行，逐段 postMessage 回传 */
async function readSseStream(port, res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta =
            json.choices && json.choices[0] && json.choices[0].delta
              ? json.choices[0].delta.content || ''
              : '';
          if (delta) {
            fullText += delta;
            safePost(port, { type: 'chunk', delta });
          }
        } catch (e) {
          /* 忽略无法解析的行 */
        }
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw makeError('ABORTED', '已取消');
    throw err;
  }

  return fullText;
}

// ================= 测试连接 =================

async function handleTestConnection(port, msg) {
  const config = msg.config;
  if (!config || !config.apiKey) {
    safePost(port, { type: 'testResult', ok: false, message: '请填写 API Key' });
    return;
  }
  try {
    const endpoint = buildEndpoint(config.baseUrl);
    const res = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey
      },
      body: JSON.stringify({
        model: config.model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 5,
        stream: false
      })
    });
    if (!res.ok) {
      await throwHttpError(res); // 抛错，由 catch 统一返回
    }
    safePost(port, { type: 'testResult', ok: true, message: '连接成功' });
  } catch (err) {
    safePost(port, { type: 'testResult', ok: false, message: friendlyError(err) });
  }
}

// ================= 工具函数 =================

/** 拼接 API 端点；针对 OpenAI 官方地址自动补全 /v1 */
function buildEndpoint(baseUrl) {
  let url = (baseUrl || '').trim();
  if (!url) url = 'https://api.openai.com/v1';
  url = url.replace(/\/+$/, '');
  if (/^https?:\/\/api\.openai\.com\/?$/i.test(url)) {
    url += '/v1';
  }
  return url;
}

/** 将 HTTP 错误转为友好的中文提示 */
async function throwHttpError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = (j.error && j.error.message) || j.message || '';
    } catch (e) {
      detail = text.slice(0, 300);
    }
  } catch (e) {
    /* ignore */
  }

  let code = 'HTTP_' + res.status;
  let message = '';
  switch (res.status) {
    case 400:
      if (/context|maximum|token|length|prompt is too long/i.test(detail)) {
        message = '上下文超长（token 超限）：请缩短正文或清空对话后重试';
      } else {
        message = '请求错误(400)' + (detail ? '：' + detail : '');
      }
      break;
    case 401:
      message = '鉴权失败(401)：API Key 无效，请检查设置';
      break;
    case 403:
      message = '无权限(403)：接口拒绝访问，请检查 API Key 或接口地址';
      break;
    case 404:
      message = '接口不存在(404)：请检查 API 地址是否正确（一般以 /v1 结尾）';
      break;
    case 429:
      message = '请求过于频繁或额度不足(429)，请稍后重试';
      break;
    case 500:
    case 502:
    case 503:
    case 504:
      message = '服务端错误(' + res.status + ')：接口暂时不可用';
      break;
    default:
      if (/context|maximum|token|length/i.test(detail)) {
        code = 'TOKEN_LIMIT';
        message = '上下文超长：请缩短正文或清空对话后重试';
      } else {
        message = '请求失败(' + res.status + ')' + (detail ? '：' + detail : '');
      }
  }

  throw makeError(code, message);
}

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function friendlyError(err) {
  return err && err.message ? err.message : '发生未知错误，请重试';
}

function abortStream(port) {
  const ctrl = activeStreams.get(port);
  if (ctrl) {
    ctrl.abort();
    activeStreams.delete(port);
  }
}

function safePost(port, data) {
  try {
    port.postMessage(data);
  } catch (e) {
    /* 端口可能已关闭 */
  }
}
