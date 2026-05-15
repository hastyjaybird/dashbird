import { refreshOpenRouterLimitMount } from '../lib/openrouter-limit-ring.js';
import { renderChatRichContent } from '../lib/chat-markdown.js';

/** Avoid `new Error(object)` → "[object Object]" when APIs return structured errors. */
function stringifyApiDetail(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && typeof value.message === 'string') return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendLine(container, role, text) {
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg--${role}`;
  renderChatRichContent(div, text);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function parseSsePayload(payload) {
  if (payload === '[DONE]') return { done: true };
  try {
    const json = JSON.parse(payload);
    const delta = json?.choices?.[0]?.delta;
    const piece = normalizeStreamDeltaContent(delta?.content);
    if (piece.length) return { text: piece };
    if (json.usage) return { usage: json.usage, model: json.model };
    if (json.model) return { model: json.model };
  } catch {
    return null;
  }
  return null;
}

function parseSseLine(line) {
  const prefix = 'data: ';
  if (!line.startsWith(prefix)) return null;
  return parseSsePayload(line.slice(prefix.length).trim());
}

function tierHint(usage) {
  const r = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof r === 'number' && r > 0) return 'reasoning';
  return 'standard';
}

function formatUsageLine(usage, model, requestedModel) {
  const m = model || requestedModel || '—';
  const modelLabel = typeof m === 'string' ? m : stringifyApiDetail(m);
  const parts = [`Model: ${modelLabel}`];
  if (usage) {
    parts.push(`Mode: ${tierHint(usage)}`);
  } else {
    parts.push('Mode: —');
  }
  return parts.join(' · ');
}

/** OpenRouter / OpenAI-style stream: `delta.content` may be a string or an array of parts. */
function normalizeStreamDeltaContent(raw) {
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  if (Array.isArray(raw)) {
    return raw
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (chunk && typeof chunk.text === 'string') return chunk.text;
        if (chunk && typeof chunk.content === 'string') return chunk.content;
        return '';
      })
      .join('');
  }
  if (typeof raw === 'object' && typeof raw.text === 'string') return raw.text;
  return '';
}

const CHAT_WIDTH_LS = 'dashbird-chat-width-px';
const CHAT_WIDTH_MIN = 260;
const CHAT_WIDTH_DEFAULT = 1360;

function maxChatWidthPx() {
  return Math.min(1600, Math.max(CHAT_WIDTH_MIN, Math.floor(window.innerWidth * 0.92)));
}

function clampChatWidthPx(px) {
  const max = maxChatWidthPx();
  return Math.min(max, Math.max(CHAT_WIDTH_MIN, Math.round(px)));
}

function applyChatWidthPx(aside, px) {
  const w = clampChatWidthPx(px);
  aside.style.setProperty('flex', `0 0 ${w}px`);
  aside.style.setProperty('width', `${w}px`);
  aside.style.setProperty('max-width', `min(90vw, ${w}px)`);
  return w;
}

/** Build placeholder shown until the first streamed token arrives. */
function mountAssistantPending(shell) {
  shell.replaceChildren();
  shell.classList.add('chat-msg--pending');
  const wrap = document.createElement('div');
  wrap.className = 'chat-pending';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  const label = document.createElement('span');
  label.className = 'chat-pending__label';
  label.textContent = 'Generating reply';
  const dots = document.createElement('span');
  dots.className = 'chat-pending__dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.textContent = '·';
    dots.append(d);
  }
  wrap.append(label, document.createTextNode(' '), dots);
  shell.append(wrap);
}

export function mountChat(root, config) {
  root.replaceChildren();
  root.className = 'chat-root';

  const parentPanel = root.parentElement;
  if (parentPanel?.classList.contains('chat-sidebar__inner')) {
    const chatAside = parentPanel.closest('.chat-sidebar');
    const resizer = document.getElementById('chat-sidebar-resizer');
    if (chatAside && resizer) {
      const saved = parseInt(localStorage.getItem(CHAT_WIDTH_LS) || '', 10);
      const computed = Math.round(parseFloat(getComputedStyle(chatAside).width) || CHAT_WIDTH_DEFAULT);
      const initial =
        Number.isFinite(saved) && saved >= CHAT_WIDTH_MIN ? clampChatWidthPx(saved) : clampChatWidthPx(computed);
      applyChatWidthPx(chatAside, initial);
      localStorage.setItem(CHAT_WIDTH_LS, String(initial));

      const mq = window.matchMedia('(min-width: 901px)');

      resizer.setAttribute('aria-valuemin', String(CHAT_WIDTH_MIN));

      function syncAriaWidth(px) {
        resizer.setAttribute('aria-valuemax', String(maxChatWidthPx()));
        resizer.setAttribute('aria-valuenow', String(Math.round(px)));
      }

      function syncResizerVisibility() {
        const on = mq.matches;
        resizer.hidden = !on;
        resizer.setAttribute('aria-hidden', on ? 'false' : 'true');
        if (!on) {
          chatAside.style.removeProperty('flex');
          chatAside.style.removeProperty('width');
          chatAside.style.removeProperty('max-width');
        } else {
          const w = clampChatWidthPx(parseInt(localStorage.getItem(CHAT_WIDTH_LS) || '', 10) || initial);
          applyChatWidthPx(chatAside, w);
          syncAriaWidth(w);
        }
      }
      syncResizerVisibility();
      mq.addEventListener('change', syncResizerVisibility);

      let dragStartX = 0;
      let dragStartW = 0;
      let dragging = false;

      function onPointerMove(ev) {
        if (!dragging) return;
        const dx = ev.clientX - dragStartX;
        const next = applyChatWidthPx(chatAside, dragStartW + dx);
        localStorage.setItem(CHAT_WIDTH_LS, String(next));
        syncAriaWidth(next);
      }

      function endDrag(ev) {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('chat-sidebar-resizer--active');
        document.body.classList.remove('chat-sidebar-resizer--dragging');
        if (resizer.hasPointerCapture(ev.pointerId)) {
          resizer.releasePointerCapture(ev.pointerId);
        }
        resizer.removeEventListener('pointermove', onPointerMove);
        resizer.removeEventListener('pointerup', endDrag);
        resizer.removeEventListener('pointercancel', endDrag);
      }

      syncAriaWidth(initial);

      resizer.addEventListener('pointerdown', (ev) => {
        if (!mq.matches || ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        dragStartX = ev.clientX;
        dragStartW = chatAside.getBoundingClientRect().width;
        resizer.classList.add('chat-sidebar-resizer--active');
        document.body.classList.add('chat-sidebar-resizer--dragging');
        resizer.setPointerCapture(ev.pointerId);
        resizer.addEventListener('pointermove', onPointerMove);
        resizer.addEventListener('pointerup', endDrag);
        resizer.addEventListener('pointercancel', endDrag);
      });

      resizer.addEventListener('keydown', (ev) => {
        if (!mq.matches) return;
        let delta = 0;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') delta = 16;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') delta = -16;
        else if (ev.key === 'Home') {
          ev.preventDefault();
          const w = applyChatWidthPx(chatAside, CHAT_WIDTH_MIN);
          localStorage.setItem(CHAT_WIDTH_LS, String(w));
          syncAriaWidth(w);
          return;
        } else if (ev.key === 'End') {
          ev.preventDefault();
          const w = applyChatWidthPx(chatAside, maxChatWidthPx());
          localStorage.setItem(CHAT_WIDTH_LS, String(w));
          syncAriaWidth(w);
          return;
        }
        if (!delta) return;
        ev.preventDefault();
        const cur = chatAside.getBoundingClientRect().width;
        const w = applyChatWidthPx(chatAside, cur + delta);
        localStorage.setItem(CHAT_WIDTH_LS, String(w));
        syncAriaWidth(w);
      });

      window.addEventListener(
        'resize',
        () => {
          if (!mq.matches) return;
          const raw = parseInt(localStorage.getItem(CHAT_WIDTH_LS) || '', 10);
          if (!Number.isFinite(raw)) return;
          const w = applyChatWidthPx(chatAside, raw);
          syncAriaWidth(w);
        },
        { passive: true },
      );
    }
  }

  const log = document.createElement('div');
  log.className = 'chat-log';

  const err = document.createElement('div');
  err.className = 'err';
  err.hidden = true;

  const form = document.createElement('form');
  form.className = 'chat-form';

  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.autocomplete = 'off';

  const metaRow = document.createElement('div');
  metaRow.className = 'chat-form__meta';
  const lastLine = document.createElement('div');
  lastLine.className = 'chat-form__meta-line';
  metaRow.append(lastLine);

  form.append(ta, metaRow);

  const history = [];
  const requestedModel = config?.openrouterModel || 'openrouter/auto';

  lastLine.textContent = formatUsageLine(null, null, requestedModel);

  const scroll = document.createElement('div');
  scroll.className = 'chat-scroll';
  scroll.append(log, err);

  const footer = document.createElement('div');
  footer.className = 'chat-footer';
  footer.append(form);

  root.append(scroll, footer);

  let sending = false;

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const content = ta.value.trim();
    if (!content || sending) return;

    ta.value = '';
    history.push({ role: 'user', content });
    appendLine(log, 'user', content);

    const assistantShell = document.createElement('div');
    assistantShell.className = 'chat-msg chat-msg--assistant';
    mountAssistantPending(assistantShell);
    log.appendChild(assistantShell);
    log.scrollTop = log.scrollHeight;

    sending = true;
    ta.disabled = true;
    const metaSnapshot = lastLine.textContent;
    lastLine.classList.add('chat-form__meta-line--busy');
    lastLine.textContent = 'Connecting to model…';
    let assistantText = '';
    let lastUsage = null;
    let lastModel = null;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        let detail = res.statusText;
        if (ct.includes('application/json')) {
          const j = await res.json().catch(() => ({}));
          const raw = j.detail ?? j.error ?? j.message;
          detail = stringifyApiDetail(raw) || detail;
        } else {
          detail = await res.text();
        }
        throw new Error(detail || `HTTP ${res.status}`);
      }

      lastLine.textContent = 'Streaming response…';

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const dec = new TextDecoder();
      let buffer = '';

      const handleLine = (raw) => {
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) return;
        const parsed = parseSseLine(line);
        if (!parsed) return;
        if (parsed.done) return;
        if (parsed.text) {
          assistantText += parsed.text;
          assistantShell.classList.remove('chat-msg--pending');
          renderChatRichContent(assistantShell, assistantText);
          log.scrollTop = log.scrollHeight;
        }
        if (parsed.model) lastModel = parsed.model;
        if (parsed.usage) {
          lastUsage = parsed.usage;
          if (parsed.model) lastModel = parsed.model;
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) handleLine(raw);
      }
      if (buffer) {
        for (const raw of buffer.split('\n')) handleLine(raw);
      }

      if (assistantText) {
        history.push({ role: 'assistant', content: assistantText });
      } else {
        assistantShell.classList.remove('chat-msg--pending');
        renderChatRichContent(
          assistantShell,
          '(empty reply — check OPENROUTER_API_KEY and model)',
        );
      }

      lastLine.textContent = formatUsageLine(lastUsage, lastModel, requestedModel);
      await refreshOpenRouterLimitMount();
    } catch (e) {
      lastLine.textContent = metaSnapshot;
      assistantShell.classList.remove('chat-msg--pending');
      assistantShell.replaceChildren();
      const msg =
        e && typeof e === 'object' && 'message' in e && typeof e.message === 'string'
          ? e.message
          : stringifyApiDetail(e);
      err.textContent = msg || 'Request failed';
      err.hidden = false;
    } finally {
      lastLine.classList.remove('chat-form__meta-line--busy');
      sending = false;
      ta.disabled = false;
    }
  });
}
