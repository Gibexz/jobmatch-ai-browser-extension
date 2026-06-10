/**
 * utils/claude_api.js — Shared Claude API utility
 *
 * Features baked in (Upgrade list items 1–5, 7):
 *   1. Latest model IDs (claude-sonnet-4-6, claude-haiku-4-5-20251001)
 *   2. Prompt caching on system blocks and large text blocks
 *   3. Streaming for long-form generation
 *   4. AbortController support on every call
 *   7. Exponential backoff on 429/529 rate-limit errors (max 3 retries)
 */

const API_URL           = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA    = 'prompt-caching-2024-07-31';

// Required by Anthropic for all direct browser → API calls
const BROWSER_ACCESS    = 'true';

// ── Model registry (Upgrade #1 — latest IDs) ─────────────────────────────────
export const MODELS = {
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001'
};

// ── Custom error ──────────────────────────────────────────────────────────────
export class ClaudeApiError extends Error {
  constructor(message, status, raw) {
    super(message);
    this.name   = 'ClaudeApiError';
    this.status = status;
    this.raw    = raw;
  }
}

// ── API key retrieval ─────────────────────────────────────────────────────────

/**
 * Retrieves the stored Anthropic API key.
 * @returns {Promise<string>}
 * @throws {ClaudeApiError} if no key is stored
 */
async function getApiKey() {
  // Local storage is the source of truth — always check it first.
  // Session storage is an in-memory cache that can hold stale values from
  // earlier in the browser session, so we only fall back to it if local is empty.
  const l = await chrome.storage.local.get('apiKey');
  if (l.apiKey) return l.apiKey;

  try {
    const s = await chrome.storage.session.get('apiKey');
    if (s.apiKey) return s.apiKey;
  } catch (_) {}

  throw new ClaudeApiError(
    'No API key set. Please open Settings (⚙) and enter your Anthropic API key.',
    0
  );
}

// ── System block builder (Upgrade #2 — prompt caching) ───────────────────────

/**
 * Converts a plain string system prompt, or an array of { text, cache? }
 * objects, into the Anthropic API system array with cache_control applied
 * to any block where cache === true (defaults to true for every block).
 *
 * Usage in agents:
 *   buildSystemBlocks("You are an expert...")
 *   buildSystemBlocks([
 *     { text: FIXED_INSTRUCTIONS },           // cached
 *     { text: cvText, cache: true },           // cached (large, reused often)
 *     { text: ephemeralNote, cache: false }    // not cached
 *   ])
 */
export function buildSystemBlocks(input) {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input, cache_control: { type: 'ephemeral' } }];
  }
  return input.map(b => ({
    type: 'text',
    text: b.text,
    ...(b.cache !== false ? { cache_control: { type: 'ephemeral' } } : {})
  }));
}

// ── Retry helper (Upgrade #7 — exponential backoff) ──────────────────────────

const MAX_RETRIES = 3;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Returns true for status codes that warrant a retry with backoff.
 * 429 = rate limit, 529 = Anthropic overloaded.
 */
function isRetryableStatus(status) {
  return status === 429 || status === 529;
}

// ── Standard (non-streaming) call ────────────────────────────────────────────

/**
 * Calls the Claude API and returns the full text response.
 *
 * @param {object} opts
 * @param {string}        opts.model       - "sonnet" | "haiku" | full model id
 * @param {string|Array}  opts.system      - system prompt string or block array
 * @param {Array}         opts.messages    - [{ role, content }]
 * @param {number}        [opts.maxTokens] - default 2048
 * @param {AbortSignal}   [opts.signal]    - for cancellation (Upgrade #4)
 * @returns {Promise<string>}
 */
export async function callClaude({ model, system, messages, maxTokens = 2048, signal }) {
  const key       = await getApiKey();
  const modelId   = MODELS[model] ?? model;
  const sysBlocks = buildSystemBlocks(system);

  const body = JSON.stringify({
    model:      modelId,
    max_tokens: maxTokens,
    system:     sysBlocks,
    messages
  });

  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(API_URL, {
        method:  'POST',
        headers: {
          'content-type':                        'application/json',
          'x-api-key':                           key,
          'anthropic-version':                   ANTHROPIC_VERSION,
          'anthropic-beta':                      ANTHROPIC_BETA,
          'anthropic-dangerous-direct-browser-access': BROWSER_ACCESS
        },
        body,
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ClaudeApiError('Network error — please check your connection.', 0);
    }

    if (isRetryableStatus(res.status)) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        throw new ClaudeApiError(
          'Rate limit reached. Please wait a moment and try again.',
          res.status
        );
      }
      await sleep(2 ** attempt * 1000); // exponential: 2 s, 4 s, 8 s
      continue;
    }

    if (res.status === 401) {
      throw new ClaudeApiError(
        'Invalid API key (401). Please open Settings (⚙) and enter a valid Anthropic API key from console.anthropic.com.',
        401
      );
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new ClaudeApiError(
        `Something went wrong (${res.status}). Please try again.`,
        res.status,
        raw
      );
    }

    const data = await res.json();
    return data.content[0].text;
  }
}

// ── Streaming call (Upgrade #3) ───────────────────────────────────────────────

/**
 * Streams a Claude response, calling onChunk(text) for each text delta.
 * Returns the full concatenated text when complete.
 *
 * @param {object} opts          - same as callClaude plus:
 * @param {Function} opts.onChunk - called with each text chunk string
 * @returns {Promise<string>}    - full response text
 */
export async function streamClaude({ model, system, messages, maxTokens = 4096, signal, onChunk }) {
  const key       = await getApiKey();
  const modelId   = MODELS[model] ?? model;
  const sysBlocks = buildSystemBlocks(system);

  const body = JSON.stringify({
    model:      modelId,
    max_tokens: maxTokens,
    stream:     true,
    system:     sysBlocks,
    messages
  });

  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(API_URL, {
        method:  'POST',
        headers: {
          'content-type':                        'application/json',
          'x-api-key':                           key,
          'anthropic-version':                   ANTHROPIC_VERSION,
          'anthropic-beta':                      ANTHROPIC_BETA,
          'anthropic-dangerous-direct-browser-access': BROWSER_ACCESS
        },
        body,
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ClaudeApiError('Network error — please check your connection.', 0);
    }

    if (isRetryableStatus(res.status)) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        throw new ClaudeApiError(
          'Rate limit reached. Please wait a moment and try again.',
          res.status
        );
      }
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (res.status === 401) {
      throw new ClaudeApiError(
        'Invalid API key (401). Please open Settings (⚙) and enter a valid Anthropic API key from console.anthropic.com.',
        401
      );
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new ClaudeApiError(
        `Something went wrong (${res.status}). Please try again.`,
        res.status,
        raw
      );
    }

    // Parse Server-Sent Events (SSE) stream line by line
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let fullText  = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Retain the incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return fullText;

          let event;
          try { event = JSON.parse(payload); } catch (_) { continue; }

          if (
            event.type  === 'content_block_delta' &&
            event.delta?.type === 'text_delta'
          ) {
            const chunk = event.delta.text;
            fullText += chunk;
            onChunk(chunk);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullText;
  }
}

// ── Tool-use call (agentic loop support) ─────────────────────────────────────

/**
 * Makes a single Claude API call with tool definitions.
 * Returns the full response object so callers can inspect stop_reason
 * and content blocks (tool_use, text) for agentic loops.
 *
 * The caller is responsible for running the loop (executing tool calls,
 * appending results, and calling this function again).
 *
 * @param {object} opts
 * @param {string}       opts.model
 * @param {string|Array} opts.system
 * @param {Array}        opts.messages   - full conversation so far
 * @param {Array}        opts.tools      - tool definitions
 * @param {number}       [opts.maxTokens]
 * @param {AbortSignal}  [opts.signal]
 * @returns {Promise<{id, type, role, content, model, stop_reason, usage}>}
 */
export async function callClaudeWithTools({ model, system, messages, tools, maxTokens = 2048, signal }) {
  const key       = await getApiKey();
  const modelId   = MODELS[model] ?? model;
  const sysBlocks = system ? buildSystemBlocks(system) : undefined;

  const bodyObj = {
    model:      modelId,
    max_tokens: maxTokens,
    tools,
    messages
  };
  if (sysBlocks) bodyObj.system = sysBlocks;

  const body = JSON.stringify(bodyObj);

  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(API_URL, {
        method:  'POST',
        headers: {
          'content-type':                              'application/json',
          'x-api-key':                                 key,
          'anthropic-version':                         ANTHROPIC_VERSION,
          'anthropic-beta':                            ANTHROPIC_BETA,
          'anthropic-dangerous-direct-browser-access': BROWSER_ACCESS
        },
        body,
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ClaudeApiError('Network error — please check your connection.', 0);
    }

    if (isRetryableStatus(res.status)) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        throw new ClaudeApiError('Rate limit reached. Please wait a moment and try again.', res.status);
      }
      await sleep(2 ** attempt * 1000);
      continue;
    }

    if (res.status === 401) {
      throw new ClaudeApiError(
        'Invalid API key (401). Please open Settings (⚙) and enter a valid Anthropic API key from console.anthropic.com.',
        401
      );
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new ClaudeApiError(`Something went wrong (${res.status}). Please try again.`, res.status, raw);
    }

    return res.json();
  }
}

// ── JSON parsing helper ───────────────────────────────────────────────────────

/**
 * Safely parses JSON from a Claude response.
 * Handles responses wrapped in markdown code fences (```json ... ```).
 *
 * @param {string} text
 * @returns {any}
 * @throws {Error} if JSON is invalid
 */
export function parseJSON(text) {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return JSON.parse(stripped);
}
