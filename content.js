/**
 * 通用网页AI阅读助手 —— 内容脚本（Content Script）
 *
 * 职责：
 *   1. 在所有网页右下角注入悬浮「AI阅读」按钮
 *   2. 提取网页标题、URL、纯净正文
 *   3. 智能过滤广告 / 侧边栏 / 导航 / 页脚 / 弹窗 / 推荐 / 评论区等
 *   4. 提取失败时降级为页面原始 innerText 并提示用户
 *   5. 通过 chrome.runtime.sendMessage 将正文交给后台（background）
 *
 * 注意：本脚本不做任何 AI 网络请求，也不接触 API Key。
 */
(() => {
  'use strict';

  // ================= 配置 =================
  const MAX_TEXT_LENGTH = 6000; // 正文最大长度（字符），超出截断，防止 token 溢出
  const MIN_TEXT_LENGTH = 120;  // 低于此长度视为提取失败，走降级逻辑

  // ================= 悬浮按钮注入 =================

  function injectButton() {
    if (document.getElementById('ai-reader-btn')) return;
    if (!document.body) return;

    const btn = document.createElement('button');
    btn.id = 'ai-reader-btn';
    btn.type = 'button';
    btn.textContent = 'AI阅读';
    btn.title = '提取正文并打开 AI 阅读助手';
    btn.addEventListener('click', onButtonClick);
    document.body.appendChild(btn);

    // 监听 body 直接子节点变化，若按钮被页面移除（部分 SPA 重渲染），自动重新注入
    observeButton();
  }

  function observeButton() {
    const mo = new MutationObserver(() => {
      if (document.body && !document.getElementById('ai-reader-btn')) {
        injectButton();
      }
    });
    mo.observe(document.body, { childList: true });
  }

  // ================= 状态提示 =================

  let toastTimer = null;
  function showToast(text, duration = 2800) {
    let el = document.getElementById('ai-reader-toast');
    if (!el && document.body) {
      el = document.createElement('div');
      el.id = 'ai-reader-toast';
      document.body.appendChild(el);
    }
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
  }

  // ================= 按钮点击：提取并通知后台 =================

  function onButtonClick() {
    showToast('正在提取正文…');

    let result;
    try {
      result = extractArticle();
    } catch (e) {
      showToast('提取失败：' + (e && e.message ? e.message : '未知错误'));
      return;
    }

    if (!result.cleanText) {
      showToast('提取失败：未能获取正文内容');
      return;
    }

    try {
      chrome.runtime.sendMessage(
        {
          action: 'OPEN_GALLERY',
          payload: {
            title: result.title,
            url: result.url,
            cleanText: result.cleanText,
            charCount: result.charCount,
            truncated: result.truncated,
            fallbackUsed: result.fallbackUsed
          }
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            showToast('通信失败：' + chrome.runtime.lastError.message);
            return;
          }
          const fallbackTip = result.fallbackUsed ? '（已降级使用原始文本）' : '';
          const truncTip = result.truncated ? '（超长已截断）' : '';
          showToast(`已提取 ${result.charCount} 字，正在打开…${fallbackTip}${truncTip}`);
        }
      );
    } catch (e) {
      showToast('通信失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  // ================= 正文抽取 =================

  function extractArticle() {
    const title = extractTitle();
    const url = location.href;

    let cleanText = '';
    let fallbackUsed = false;

    try {
      cleanText = extractMainText();
    } catch (e) {
      cleanText = '';
    }

    // 抽取结果过短则降级为原始文本
    if (!cleanText || cleanText.length < MIN_TEXT_LENGTH) {
      cleanText = fallbackText();
      fallbackUsed = true;
    }

    const originalLength = cleanText.length;
    let truncated = false;
    if (cleanText.length > MAX_TEXT_LENGTH) {
      cleanText = cleanText.slice(0, MAX_TEXT_LENGTH);
      truncated = true;
    }

    return { title, url, cleanText, charCount: originalLength, truncated, fallbackUsed };
  }

  /** 标题优先级：og:title > h1 > document.title */
  function extractTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content && og.content.trim()) return og.content.trim();

    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent && h1.textContent.trim()) return h1.textContent.trim();

    return (document.title || '').trim();
  }

  /** 正文抽取主流程：克隆 DOM → 过滤噪声 → 打分定位主内容容器 → 提取文本 */
  function extractMainText() {
    const clone = document.body.cloneNode(true);
    removeJunk(clone);
    const container = findMainContainer(clone);
    const text = container ? elementToText(container) : elementToText(clone);
    return normalizeText(text);
  }

  /** 降级：直接取 body 的 innerText（保留可见文本与换行） */
  function fallbackText() {
    let text = '';
    try {
      text = document.body.innerText || document.body.textContent || '';
    } catch (e) {
      text = document.body.textContent || '';
    }
    return normalizeText(text);
  }

  /**
   * 移除噪声元素：脚本/样式/框架/表单/导航/页脚/侧边栏/广告/评论/推荐/弹窗等。
   * 使用 CSS 属性选择器的 i 标志做大小写不敏感匹配（Chrome 49+ 支持）。
   */
  function removeJunk(root) {
    const selectors = [
      'script', 'style', 'noscript', 'link', 'meta', 'iframe', 'canvas', 'svg',
      'video', 'audio', 'object', 'embed', 'map', 'area',
      'form', 'button', 'input', 'select', 'textarea', 'option',
      'nav', 'header', 'footer', 'aside', 'dialog',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '[role="complementary"]', '[role="search"]',
      '[aria-hidden="true"]', '[hidden]',
      '[class*="ad" i]', '[id*="ad" i]',
      '[class*="ads" i]', '[id*="ads" i]',
      '[class*="advert" i]', '[id*="advert" i]',
      '[class*="banner" i]', '[id*="banner" i]',
      '[class*="sidebar" i]', '[id*="sidebar" i]',
      '[class*="aside" i]', '[id*="aside" i]',
      '[class*="comment" i]', '[id*="comment" i]',
      '[class*="recommend" i]', '[id*="recommend" i]',
      '[class*="related" i]', '[id*="related" i]',
      '[class*="share" i]', '[id*="share" i]',
      '[class*="social" i]', '[id*="social" i]',
      '[class*="popup" i]', '[class*="modal" i]', '[class*="dialog" i]',
      '[class*="cookie" i]', '[id*="cookie" i]',
      '[class*="toolbar" i]', '[id*="toolbar" i]',
      '[class*="breadcrumb" i]', '[id*="breadcrumb" i]',
      '[class*="pagination" i]', '[id*="pagination" i]',
      '[class*="footer" i]', '[id*="footer" i]',
      '[class*="header" i]', '[id*="header" i]',
      '[class*="nav" i]', '[id*="nav" i]',
      '[class*="menu" i]', '[id*="menu" i]'
    ];

    root.querySelectorAll(selectors.join(',')).forEach((el) => {
      el.remove();
    });
  }

  /**
   * 定位主内容容器（简化版 Readability 打分）：
   * 对每个文本块（p/li/blockquote 等）计算文本长度 + 标点密度得分，
   * 并把得分累加到其所有祖先元素上；得分最高的祖先即为主内容容器。
   */
  function findMainContainer(root) {
    const scores = new Map();

    const blocks = root.querySelectorAll(
      'p, pre, blockquote, li, td, th, h1, h2, h3, h4, h5, h6'
    );
    blocks.forEach((el) => {
      const text = (el.textContent || '').trim();
      if (text.length < 20) return; // 忽略过短文本块

      let score = text.length;
      const punctCount = (text.match(/[，。！？,.!?;；:：、]/g) || []).length;
      score += punctCount * 10;

      let node = el.parentElement;
      let guard = 0;
      while (node && node !== root && guard < 20) {
        scores.set(node, (scores.get(node) || 0) + score);
        node = node.parentElement;
        guard++;
      }
    });

    let best = null;
    let bestScore = 0;
    scores.forEach((s, el) => {
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    });
    return best;
  }

  // 块级标签集合：用于在文本提取时插入换行，保留段落结构
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
    'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
    'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'HR', 'BR'
  ]);

  /** 将 DOM 子树转为带换行的纯文本（适用于脱离文档的克隆节点） */
  function elementToText(el) {
    let out = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toUpperCase();
        if (tag === 'BR') {
          out += '\n';
        } else {
          out += elementToText(node);
          if (BLOCK_TAGS.has(tag)) out += '\n';
        }
      }
    });
    return out;
  }

  /** 文本预处理：压缩空白、合并换行、去除多余空格 */
  function normalizeText(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')     // 不换行空格 → 普通空格
      .replace(/[ \t]+/g, ' ')     // 合并空格与制表符
      .replace(/ *\n */g, '\n')    // 去除换行两侧空格
      .replace(/\n{3,}/g, '\n\n')  // 3 个以上换行压缩为 2 个
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }

  // ================= 初始化 =================

  function init() {
    if (document.body) {
      injectButton();
    } else {
      document.addEventListener('DOMContentLoaded', injectButton);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
