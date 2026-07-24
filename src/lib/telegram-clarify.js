/**
 * Pending Telegram intake clarifications (inline keyboard).
 * When the classifier is unsure, we ask with buttons and resume from this store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PROMPT_TTL_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function telegramClarifyPromptsPath(env = process.env) {
  const override = String(env.TELEGRAM_CLARIFY_PROMPTS_PATH || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.join(PKG_ROOT, override);
  }
  return path.join(PKG_ROOT, 'data', 'telegram-clarify-prompts.json');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadPromptsFile(env = process.env) {
  try {
    const raw = fs.readFileSync(telegramClarifyPromptsPath(env), 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : { prompts: {} };
  } catch {
    return { prompts: {} };
  }
}

/**
 * @param {{ prompts: Record<string, object> }} data
 * @param {NodeJS.ProcessEnv} [env]
 */
function savePromptsFile(data, env = process.env) {
  const filePath = telegramClarifyPromptsPath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
function pruneExpired(data, env = process.env) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(data.prompts || {})) {
    if (Number(v?.expiresAt) && Number(v.expiresAt) < now) {
      delete data.prompts[k];
      changed = true;
    }
  }
  if (changed) savePromptsFile(data, env);
  return data;
}

/**
 * @param {{
 *   chatId: number | string,
 *   mode: 'text' | 'image',
 *   text?: string | null,
 *   caption?: string | null,
 *   message?: object | null,
 *   mediaLocalPath?: string | null,
 *   mediaMime?: string | null,
 *   mediaFileId?: string | null,
 *   mediaKind?: string | null,
 *   classified?: object | null,
 *   suggestedType?: string | null,
 *   reason?: string | null,
 * }} input
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createTelegramClarifyPrompt(input, env = process.env) {
  const promptId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const data = pruneExpired(loadPromptsFile(env), env);
  if (!data.prompts || typeof data.prompts !== 'object') data.prompts = {};

  const now = Date.now();
  data.prompts[promptId] = {
    promptId,
    chatId: input.chatId,
    mode: input.mode === 'image' ? 'image' : 'text',
    text: input.text != null ? String(input.text).slice(0, 8000) : null,
    caption: input.caption != null ? String(input.caption).slice(0, 2000) : null,
    // Keep a lean message stub for ingest helpers that read chat/date/ids.
    message: input.message
      ? {
          message_id: input.message.message_id,
          date: input.message.date,
          chat: input.message.chat,
          from: input.message.from,
          text: input.message.text,
          caption: input.message.caption,
        }
      : null,
    mediaLocalPath: input.mediaLocalPath ? String(input.mediaLocalPath) : null,
    mediaMime: input.mediaMime ? String(input.mediaMime) : null,
    mediaFileId: input.mediaFileId ? String(input.mediaFileId) : null,
    mediaKind: input.mediaKind ? String(input.mediaKind) : null,
    classified: input.classified && typeof input.classified === 'object' ? input.classified : null,
    suggestedType: input.suggestedType ? String(input.suggestedType) : null,
    reason: input.reason ? String(input.reason).slice(0, 400) : null,
    createdAt: now,
    expiresAt: now + PROMPT_TTL_MS,
  };
  savePromptsFile(data, env);
  return data.prompts[promptId];
}

/**
 * @param {string} promptId
 * @param {NodeJS.ProcessEnv} [env]
 */
export function consumeTelegramClarifyPrompt(promptId, env = process.env) {
  const id = String(promptId || '').trim();
  if (!id) return null;
  const data = loadPromptsFile(env);
  const prompt = data.prompts?.[id] || null;
  if (prompt) {
    delete data.prompts[id];
    savePromptsFile(data, env);
  }
  if (!prompt) return null;
  if (Number(prompt.expiresAt) && Number(prompt.expiresAt) < Date.now()) return null;
  return prompt;
}

/** Short codes in callback_data (64-byte Telegram limit). */
export const CLARIFY_TYPE_CODES = {
  e: 'event',
  t: 'todo',
  n: 'note',
  c: 'contact',
  o: 'company',
  x: 'skip',
};

/**
 * @param {'text' | 'image'} mode
 * @param {string} promptId
 * @param {string | null} [suggestedType]
 */
export function clarifyKeyboard(mode, promptId, suggestedType = null) {
  const id = String(promptId || '').trim();
  const rows =
    mode === 'image'
      ? [
          [
            { text: 'Event', callback_data: `clf:e:${id}` },
            { text: 'Contact', callback_data: `clf:c:${id}` },
          ],
          [
            { text: 'Company', callback_data: `clf:o:${id}` },
            { text: 'Note', callback_data: `clf:n:${id}` },
          ],
          [{ text: 'Skip', callback_data: `clf:x:${id}` }],
        ]
      : [
          [
            { text: 'Event', callback_data: `clf:e:${id}` },
            { text: 'Todo', callback_data: `clf:t:${id}` },
            { text: 'Note', callback_data: `clf:n:${id}` },
          ],
          [
            { text: 'Contact', callback_data: `clf:c:${id}` },
            { text: 'Company', callback_data: `clf:o:${id}` },
          ],
          [{ text: 'Skip', callback_data: `clf:x:${id}` }],
        ];

  // Put suggested type first when we have a soft guess.
  if (suggestedType && mode === 'image') {
    const label =
      suggestedType === 'contact'
        ? 'Contact'
        : suggestedType === 'company'
          ? 'Company'
          : suggestedType === 'note'
            ? 'Note'
            : suggestedType === 'event'
              ? 'Event'
              : null;
    if (label) {
      for (const row of rows) {
        const idx = row.findIndex((b) => b.text === label);
        if (idx > 0) {
          const [btn] = row.splice(idx, 1);
          row.unshift(btn);
          break;
        }
      }
    }
  }

  return { inline_keyboard: rows };
}
