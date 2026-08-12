/**
 * Copilot settings, stored in localStorage under the same keys Mesh uses, so a
 * key entered in one Physbox app works in the others on the same browser.
 *
 * Keys live in the browser and are sent straight from it to the provider. That
 * is the only option for a static build with no backend, and it means the key
 * never reaches a Physbox server — but it also means anything with access to
 * this origin's localStorage can read it. Use a key scoped to this purpose.
 */

export const GEMINI_KEY = 'gemini_api_key';
export const ANTHROPIC_KEY = 'anthropic_api_key';
export const MODEL_KEY = 'gemini_model';
export const MAX_TOKENS_KEY = 'copilot_max_tokens';

export const DEFAULT_MODEL = 'claude-opus-5';

export const DEFAULT_MAX_TOKENS = 16000;
export const MIN_MAX_TOKENS = 2000;
export const MAX_MAX_TOKENS = 64000;

/** Shown until the provider's own model list arrives. */
export const FALLBACK_MODELS: { id: string; name: string }[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
];

export const isClaudeModel = (model: string) => model.startsWith('claude');

const read = (key: string): string => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    // localStorage throws in private-mode / sandboxed contexts.
    return '';
  }
};

import { syncCloudParameters } from './apiClient';

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
    syncCloudParameters('global', { [key]: value });
  } catch {
    // Non-fatal: the setting just won't survive a reload.
  }
};

export const readGeminiKey = () => read(GEMINI_KEY);
export const readAnthropicKey = () => read(ANTHROPIC_KEY);
export const writeGeminiKey = (v: string) => write(GEMINI_KEY, v.trim());
export const writeAnthropicKey = (v: string) => write(ANTHROPIC_KEY, v.trim());

export const readModel = () => read(MODEL_KEY) || DEFAULT_MODEL;
export const writeModel = (v: string) => write(MODEL_KEY, v);

export const clampMaxTokens = (value: number): number => {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOKENS;
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)));
};

/**
 * The output budget. This is user-visible because the failure it controls is
 * silent and expensive: when the geometry doesn't fit in the reply, the JSON is
 * cut off mid-structure, parsing fails, and nothing is applied.
 */
export const readMaxTokens = (): number => {
  const raw = read(MAX_TOKENS_KEY);
  if (!raw) return DEFAULT_MAX_TOKENS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampMaxTokens(parsed) : DEFAULT_MAX_TOKENS;
};

export const writeMaxTokens = (value: number): number => {
  const clamped = clampMaxTokens(value);
  write(MAX_TOKENS_KEY, String(clamped));
  return clamped;
};
