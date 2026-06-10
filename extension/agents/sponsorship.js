/**
 * Agent 3 — Sponsorship Analyser (popup module)
 *
 * 3-tier analysis:
 *   Tier 1 — Explicit page mention  → immediate verdict (no API call)
 *   Tier 2 — Cached Register + salary threshold → verdict (no API call)
 *   Tier 3 — Claude agentic search loop → fallback for ambiguous cases
 *
 * The Register of Licensed Sponsors is downloaded from gov.uk once per day
 * and stored in chrome.storage.local.  Salary thresholds are hardcoded and
 * refreshed from gov.uk once per day.
 */

import { callClaudeWithTools, buildSystemBlocks, parseJSON } from '../utils/claude_api.js';
import { getSponsorshipReadiness }                            from './personal_vault.js';

// ─────────────────────────────────────────────────────────────────────────────
// Job extraction (from tab content script)
// ─────────────────────────────────────────────────────────────────────────────

export async function extractJobFromTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_JOB' }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(
          'Could not read job details from this page. ' +
          'Make sure you are on a job listing page and the page is fully loaded.'
        ));
        return;
      }
      if (!response?.title) {
        reject(new Error(
          'No job details were found on this page. ' +
          'Please navigate to a specific job listing, not a search results page.'
        ));
        return;
      }
      resolve(response);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Register of Licensed Sponsors — download, cache, lookup
// ─────────────────────────────────────────────────────────────────────────────

const REGISTER_KEY    = 'jm_sponsorRegister';
const ONE_DAY_MS      = 24 * 60 * 60 * 1000;

// gov.uk content API — returns JSON with attachment URLs (CORS-open endpoint)
const REGISTER_API_URL =
  'https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers';

/**
 * Simple CSV line parser — handles double-quoted fields containing commas.
 */
function parseCSVLine(line) {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service-worker fetch proxy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proxy a fetch through the service worker to avoid popup CSP violations.
 * gov.uk sends "Link: preload" headers on every response; these headers trigger
 * the extension's "script-src 'self'" CSP when received in the popup context.
 * The service worker has no extension-page CSP, so requests are safe there.
 *
 * @param {string} url       - Must start with an allow-listed gov.uk domain.
 * @param {object} [headers] - Request headers forwarded to the SW.
 * @returns {Promise<string>}  Response body text.
 */
async function swFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Service worker proxy timeout')), 35_000
    );
    chrome.runtime.sendMessage({ type: 'PROXY_FETCH', url, headers }, reply => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (reply?.error) {
        reject(new Error(reply.error));
        return;
      }
      resolve(reply?.text ?? '');
    });
  });
}

/**
 * Fetch the current Register CSV download URL.
 *
 * Attempts (in order):
 *   1. gov.uk content API (JSON) — proxied through SW to avoid CSP violations
 *   2. Service worker HTML scrape of the publications page
 */
async function getRegisterCsvUrl() {
  // Attempt 1: JSON content API — proxied through SW so popup CSP is never triggered
  try {
    const text = await swFetch(REGISTER_API_URL, { Accept: 'application/json' });
    const data = JSON.parse(text);
    const attachments = data.details?.attachments ?? [];
    const csv = attachments.find(a =>
      a.content_type === 'text/csv' ||
      (typeof a.url      === 'string' && a.url.toLowerCase().endsWith('.csv')) ||
      (typeof a.filename === 'string' && a.filename.toLowerCase().endsWith('.csv'))
    );
    if (csv?.url) {
      return csv.url.startsWith('http') ? csv.url : `https://assets.publishing.service.gov.uk${csv.url}`;
    }
  } catch (_) {}

  // Attempt 2: ask the service worker to do the HTML scrape.
  try {
    const reply = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SW timeout')), 10_000);
      chrome.runtime.sendMessage({ type: 'FIND_REGISTER_CSV_URL' }, r => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(r);
      });
    });
    if (reply?.url) return reply.url;
    if (reply?.error) throw new Error(reply.error);
  } catch (_) {}

  throw new Error('Could not locate the Register of Licensed Sponsors CSV URL.');
}

/**
 * Download, parse, and cache the Register of Licensed Sponsors.
 * Stores employer names (lower-cased) for the Skilled Worker route.
 *
 * @param {function} [onProgress] - optional (msg: string) => void
 */
async function fetchAndCacheRegister(onProgress) {
  onProgress?.('Finding register download link…');
  const csvUrl = await getRegisterCsvUrl();

  onProgress?.('Downloading register (may take a moment)…');
  // Route through SW proxy — assets CDN is on the allow-list and this keeps
  // ALL gov.uk/UKVI network calls out of the popup's CSP context.
  const csvText = await swFetch(csvUrl);
  if (!csvText) throw new Error('Register CSV download failed — empty response.');

  onProgress?.('Parsing register…');
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) throw new Error('Register CSV appears empty.');

  // Identify column indices from the header row
  const headers  = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const nameIdx  = headers.findIndex(h => h.includes('organisation') || h === 'name');
  const routeIdx = headers.findIndex(h => h.includes('route') || h.includes('type'));

  if (nameIdx < 0) throw new Error('Cannot find organisation name column in the register CSV.');

  // Collect employer names for the Skilled Worker route
  const employers = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols  = parseCSVLine(lines[i]);
    const name  = cols[nameIdx]?.replace(/"/g, '').trim();
    const route = (cols[routeIdx] ?? '').replace(/"/g, '').toLowerCase().trim();

    if (!name) continue;

    // Include if route column is absent or mentions Skilled Worker
    if (routeIdx < 0 || !route || route.includes('skilled') || route.includes('worker')) {
      employers.push(name.toLowerCase());
    }
  }

  const entry = {
    employers,
    count:       employers.length,
    csvUrl,
    lastUpdated: Date.now()
  };

  // chrome.storage.local limit is 10 MB; ~100k register entries × 30 chars avg ≈ 3 MB — safe
  await chrome.storage.local.set({ [REGISTER_KEY]: entry });
  onProgress?.(`Register cached — ${employers.length.toLocaleString()} licensed sponsors.`);
  return entry;
}

/**
 * Return the cached register, refreshing it if it is older than 24 h.
 * Never throws — on network failure it returns the stale cache (or null).
 *
 * @param {function} [onProgress]
 */
async function ensureRegister(onProgress) {
  try {
    const r      = await chrome.storage.local.get(REGISTER_KEY);
    const cached = r[REGISTER_KEY];
    const stale  = !cached || (Date.now() - cached.lastUpdated) > ONE_DAY_MS;

    if (!stale) return cached;             // fresh — use as-is
    return await fetchAndCacheRegister(onProgress);
  } catch (err) {
    console.warn('JobMatch AI: register update failed:', err.message);
    // Fall back to stale cache rather than blocking the user
    try {
      const r = await chrome.storage.local.get(REGISTER_KEY);
      return r[REGISTER_KEY] ?? null;
    } catch (_) { return null; }
  }
}

// Export for Settings "Refresh register" button
export { ensureRegister };

/**
 * Normalise an employer name for fuzzy matching.
 * Converts common abbreviations, strips legal/organisational suffixes,
 * and removes characters that differ between the register and job ads.
 */
function normaliseEmployer(name) {
  return name
    .toLowerCase()
    // Normalise ampersand BEFORE anything else ("X & Y" → "X and Y")
    .replace(/\s*&\s*/g,                             ' and ')
    // Remove "the" articles
    .replace(/\bthe\b/g,                             '')
    // Strip NHS organisational suffixes (order matters — longest first)
    .replace(/\bnhs\s*foundation\s*trust\b/g,        '')
    .replace(/\bnhs\s*trust\b/g,                     '')
    .replace(/\bnhs\b/g,                             '')
    .replace(/\bfoundation\s*trust\b/g,              '')
    .replace(/\buniversity\s*hospitals?\b/g,          '')
    .replace(/\bhospitals?\b/g,                      '')
    .replace(/\bhealthcare\b/g,                      '')
    .replace(/\bhealth\s*care\b/g,                   '')
    .replace(/\bfoundation\b/g,                      '')
    .replace(/\btrust\b/g,                           '')
    .replace(/\blimited\b|\bltd\.?\b/g,              '')
    .replace(/\bplc\.?\b/g,                          '')
    // Strip remaining non-alphanumeric chars, collapse spaces
    .replace(/[^a-z0-9\s]/g,                         '')
    .replace(/\s+/g,                                  ' ')
    .trim();
}

/**
 * Check if an employer name appears in the cached register.
 * Returns true (found) | false (not found) | null (register unavailable).
 */
function checkEmployerOnRegister(employerName, register) {
  if (!register?.employers?.length || !employerName) return null;

  const needle     = employerName.toLowerCase().trim();
  const needleNorm = normaliseEmployer(needle);
  if (!needleNorm) return null;

  for (const emp of register.employers) {
    if (emp === needle) return true;                         // exact
    const empNorm = normaliseEmployer(emp);
    if (!empNorm) continue;
    if (empNorm === needleNorm) return true;                 // normalised exact
    if (needleNorm.length >= 6 && empNorm.length >= 6) {
      if (empNorm.includes(needleNorm) || needleNorm.includes(empNorm)) return true;
    }
  }

  return false;
}

/**
 * When an employer is not found exactly, return the top-N register entries
 * that share significant words with the search name.
 * Used to surface "did you mean…?" candidates in the verdict UI.
 *
 * @param {string} employerName
 * @param {object} register - cached register object
 * @param {number} [limit=8]
 * @returns {string[]} - original-cased names from the register
 */
function findSimilarEmployers(employerName, register, limit = 8) {
  if (!register?.employers?.length || !employerName) return [];

  // Significant words: 3+ chars, ignoring ultra-common NHS words
  const STOP = new Set(['the','and','for','nhs','trust','care','health','services',
                        'service','centre','center','national','institute','ltd','plc']);
  const needleWords = normaliseEmployer(employerName)
    .split(' ')
    .filter(w => w.length >= 3 && !STOP.has(w));

  if (!needleWords.length) return [];

  const scored = [];
  for (const emp of register.employers) {
    const empNorm = normaliseEmployer(emp);
    let score = 0;
    for (const w of needleWords) {
      if (empNorm.includes(w))           score += 3; // substring hit
      else if (empNorm.startsWith(w[0])) score += 1; // first-letter match (weak)
    }
    if (score > 0) scored.push({ name: emp, score });
  }

  // Return original-case names (register stores lower-case; title-case for display)
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(e => e.name.replace(/\b\w/g, c => c.toUpperCase())); // Title Case
}

// ─────────────────────────────────────────────────────────────────────────────
// Salary threshold helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current Skilled Worker visa salary thresholds (UK Home Office, April 2024).
 * Hardcoded for Tier 1/2 instant checks — Tier 3 AI search verifies the latest
 * figures from gov.uk to catch any threshold changes since this was last updated.
 */
const THRESHOLDS = {
  general:    38700,   // Standard threshold (April 2024)
  newEntrant: 30960,   // New entrant / recent graduate (80 % of general)
  healthCare: 23200,   // Health and Care Worker route (specific SOC codes)
  lastKnown:  '2024-04-04'
};

/**
 * Parse a salary string such as "£38,000 - £45,000 per annum" into { min, max }.
 * Returns null if no recognisable salary range found.
 */
function parseSalary(str) {
  if (!str) return null;
  const nums = [...(str.matchAll(/£?\s*(\d[\d,]*)/g) ?? [])]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(n => n >= 5000 && n <= 999999);  // plausible salary range
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/**
 * Determine if the advertised salary meets the general skilled-worker threshold.
 * Returns true | false | null (null = salary not parseable).
 */
function salaryMeetsThreshold(salaryStr) {
  const range = parseSalary(salaryStr);
  if (!range) return null;
  // Use max: if the upper end of a banded salary meets the threshold the role is eligible
  return range.max >= THRESHOLDS.general;
}

// ─────────────────────────────────────────────────────────────────────────────
// gov.uk tool implementations (Tier 3 agentic loop)
// ─────────────────────────────────────────────────────────────────────────────

const GOV_UK_SEARCH = 'https://www.gov.uk/api/search.json';
const GOV_UK_BASE   = 'https://www.gov.uk';

async function searchGovUK(query) {
  try {
    const url  = `${GOV_UK_SEARCH}?q=${encodeURIComponent(query)}&count=5&fields=title,link,description`;
    // Proxy through SW to avoid popup CSP violations from gov.uk response headers
    const text = await swFetch(url, { Accept: 'application/json' });
    const data = JSON.parse(text);
    return {
      results: (data.results ?? []).map(r => ({
        title:       r.title       ?? '',
        link:        `${GOV_UK_BASE}${r.link}`,
        description: r.description ?? ''
      }))
    };
  } catch (err) { return { error: err.message }; }
}

async function fetchGovUKPage(url) {
  try {
    if (!url.startsWith('https://www.gov.uk')) return { error: 'Only gov.uk URLs allowed.' };
    // Proxy through SW to avoid popup CSP violations
    const html = await swFetch(url, { Accept: 'text/html' });
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,   '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g,  ' ')
      .trim()
      .slice(0, 6000);
    return { url, text };
  } catch (err) { return { error: err.message }; }
}

// Tool definitions for Claude (Tier 3)
const TOOLS = [
  {
    name:        'search_gov_uk',
    description: 'Search gov.uk — use to check if an employer appears on the UK Register of Licensed Sponsors, look up salary threshold guidance, SOC codes, and Skilled Worker visa requirements.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query string' } },
      required:   ['query']
    }
  },
  {
    name:        'fetch_gov_uk_page',
    description: 'Fetch the text content of a gov.uk page to get detailed guidance or verify specific information.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full https://www.gov.uk URL' } },
      required:   ['url']
    }
  }
];

// System prompt for the Claude agentic loop
const SYSTEM = `\
You are an expert UK immigration and NHS recruitment specialist.
Analyse whether this employer can offer Skilled Worker visa sponsorship.

You have already checked the local Register of Licensed Sponsors cache and it was inconclusive.
Use the search_gov_uk and fetch_gov_uk_page tools to:
1. Confirm whether the employer appears on the UK Register of Licensed Sponsors.
2. Check the current Skilled Worker visa salary threshold for this type of role / SOC code.
3. Compare the advertised salary to the threshold.

When you have gathered enough information, output ONLY the following JSON (no tool calls after):
{
  "status": "LIKELY_SPONSORABLE" | "UNCERTAIN" | "UNLIKELY_SPONSORABLE",
  "reasons": ["<reason 1>", "<reason 2>"],
  "sourceUrls": ["<url>"],
  "employerOnRegister": true | false | null,
  "salaryThreshold": <number or null>,
  "salaryMeetsThreshold": true | false | null,
  "socCode": "<code or null>",
  "explicitMention": "yes" | "no" | null
}

Status rules:
- LIKELY_SPONSORABLE:   Employer on register AND salary meets threshold
- UNCERTAIN:            Register status unclear, salary borderline, or information incomplete
- UNLIKELY_SPONSORABLE: Employer NOT on register, OR salary clearly below threshold`;

// ─────────────────────────────────────────────────────────────────────────────
// Main analysis entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse sponsorship for a job.
 *
 * @param {object}   jobData    - from extractJobFromTab()
 * @param {AbortSignal} [signal]
 * @param {function} [onProgress] - (message: string) => void for UI feedback
 * @returns {Promise<SponsorshipResult>}
 */
export async function analyseSponsorship(jobData, signal, onProgress) {

  // ── TIER 1: Explicit mention — cheapest check, no API call needed ────────────
  const explicit = jobData.sponsorshipMentions?.explicit;

  if (explicit === 'no') {
    return {
      status:               'UNLIKELY_SPONSORABLE',
      reasons: [
        'The job listing explicitly states that visa sponsorship is not available.',
        ...(jobData.sponsorshipMentions?.text ?? [])
      ],
      sourceUrls:           [jobData.url],
      employerOnRegister:   null,
      salaryThreshold:      null,
      salaryMeetsThreshold: null,
      socCode:              null,
      explicitMention:      'no'
    };
  }

  if (explicit === 'yes') {
    const salaryOk = salaryMeetsThreshold(jobData.salary);
    const reasons  = [
      'The job listing explicitly mentions Skilled Worker visa sponsorship is available.',
      ...(jobData.sponsorshipMentions?.text ?? [])
    ];
    if (jobData.salary) {
      reasons.push(
        salaryOk === false
          ? `Advertised salary (${jobData.salary}) may be below the £${THRESHOLDS.general.toLocaleString()} general threshold — verify the exact SOC code threshold.`
          : `Advertised salary: ${jobData.salary}.`
      );
    }
    return {
      status:               'LIKELY_SPONSORABLE',
      reasons,
      sourceUrls:           [jobData.url],
      employerOnRegister:   null,
      salaryThreshold:      THRESHOLDS.general,
      salaryMeetsThreshold: salaryOk,
      socCode:              null,
      explicitMention:      'yes'
    };
  }

  // ── TIER 2: Cached register lookup — fast, no API call if register is fresh ──
  onProgress?.('Checking Register of Licensed Sponsors…');

  const register   = await ensureRegister(onProgress);
  const onRegister = checkEmployerOnRegister(jobData.company, register);
  const salaryOk   = salaryMeetsThreshold(jobData.salary);
  const sources    = ['https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers'];

  // ── Exact / normalised match found — definitive yes ───────────────────────
  if (register && onRegister === true) {
    const reasons = [
      `✓ "${jobData.company}" is on the UK Register of Licensed Sponsors.`,
      buildSalaryReason(jobData.salary, salaryOk)
    ].filter(Boolean);
    return {
      status:               salaryOk === false ? 'UNCERTAIN' : 'LIKELY_SPONSORABLE',
      reasons:              salaryOk === false
        ? [...reasons, 'Check the role-specific SOC code — NHS health roles may qualify for the lower Health and Care Worker threshold.']
        : reasons,
      sourceUrls:           sources,
      employerOnRegister:   true,
      salaryThreshold:      THRESHOLDS.general,
      salaryMeetsThreshold: salaryOk,
      socCode: null, explicitMention: null
    };
  }

  // ── Not found or inconclusive — ask the user to select from similar names ─
  if (register && (onRegister === false || onRegister === null)) {
    const similar = jobData.company ? findSimilarEmployers(jobData.company, register) : [];

    if (similar.length > 0) {
      // Return a special status; popup will render the selection UI
      return {
        status:           'NEEDS_SELECTION',
        reasons: [
          jobData.company
            ? `"${jobData.company}" was not found exactly. Select the correct organisation below to confirm register status:`
            : 'Employer name could not be detected. Select the correct organisation below if you recognise it:'
        ],
        similarEmployers: similar,          // array of title-cased display names
        sourceUrls:       sources,
        employerOnRegister: null,
        salaryThreshold:  THRESHOLDS.general,
        salaryMeetsThreshold: salaryOk,
        socCode: null, explicitMention: null
      };
    }

    // No similar names found at all — fall through to Tier 3
  }

  // ── TIER 3: Claude agentic gov.uk search — only reached when register is
  //    unavailable or no sufficiently similar employer names were found ─────────
  return runTier3AgenticSearch(jobData, register, salaryOk, signal, onProgress);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — Claude agentic gov.uk search loop
// ─────────────────────────────────────────────────────────────────────────────

async function runTier3AgenticSearch(jobData, register, salaryOk, signal, onProgress) {
  onProgress?.('Running AI analysis on gov.uk…');

  const userMsg = [
    `Please analyse the sponsorship status for this job.`,
    `Employer:   ${jobData.company || 'Unknown'}`,
    `Job Title:  ${jobData.title   || 'Unknown'}`,
    `Salary:     ${jobData.salary  || 'Not stated'}`,
    ``,
    `Job description excerpt:`,
    jobData.descriptionText?.slice(0, 3000) || '(none)',
    ``,
    `No explicit sponsorship mention was found. The local register cache was ` +
    `${register ? 'inconclusive (name mismatch)' : 'unavailable'}. ` +
    `Search the Register of Licensed Sponsors and current salary thresholds, ` +
    `then return your final JSON verdict.`
  ].join('\n');

  const messages = [{ role: 'user', content: userMsg }];
  const system   = buildSystemBlocks(SYSTEM);
  const MAX_TURNS = 6;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callClaudeWithTools({
      model: 'sonnet', system, messages, tools: TOOLS, maxTokens: 2048, signal
    });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      if (textBlock) {
        try {
          const verdict = parseJSON(textBlock.text);
          if (verdict.status) return verdict;
        } catch (_) {}
      }
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let output;
        if      (block.name === 'search_gov_uk')      output = await searchGovUK(block.input.query);
        else if (block.name === 'fetch_gov_uk_page')  output = await fetchGovUKPage(block.input.url);
        else                                           output = { error: `Unknown tool: ${block.name}` };

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(output) });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user',      content: toolResults });
      continue;
    }
    break;
  }

  // Fallback if loop exhausted without a verdict
  return {
    status:               'UNCERTAIN',
    reasons: [
      register
        ? `"${jobData.company}" — name could not be matched in the register. Please verify manually.`
        : 'Could not download the Register of Licensed Sponsors.',
      'Visit gov.uk to search for this employer directly.'
    ],
    sourceUrls:           ['https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers'],
    employerOnRegister:   null,
    salaryThreshold:      THRESHOLDS.general,
    salaryMeetsThreshold: salaryOk ?? null,
    socCode: null, explicitMention: null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// User confirms employer selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when the user selects an employer from the NEEDS_SELECTION list.
 *
 * @param {string}      selectedName  - display name chosen, or 'none'
 * @param {object}      jobData       - original job data
 * @param {AbortSignal} [signal]
 * @param {function}    [onProgress]
 * @returns {Promise<SponsorshipResult>}
 */
export async function confirmEmployerSelection(selectedName, jobData, signal, onProgress) {
  if (selectedName === 'none') {
    // User said none match — run Tier 3 AI search as last resort
    onProgress?.('Running AI analysis on gov.uk…');
    return runTier3AgenticSearch(jobData, null, salaryMeetsThreshold(jobData.salary), signal, onProgress);
  }

  // User confirmed a register match — they're on the register by definition
  const salaryOk = salaryMeetsThreshold(jobData.salary);
  const reasons  = [
    `✓ "${selectedName}" confirmed on the Register of Licensed Sponsors (selected by you).`,
    buildSalaryReason(jobData.salary, salaryOk)
  ].filter(Boolean);

  return {
    status:               salaryOk === false ? 'UNCERTAIN' : 'LIKELY_SPONSORABLE',
    reasons:              salaryOk === false
      ? [...reasons, 'Check the role-specific SOC code threshold for confirmation.']
      : reasons,
    sourceUrls:           ['https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers'],
    employerOnRegister:   true,
    salaryThreshold:      THRESHOLDS.general,
    salaryMeetsThreshold: salaryOk,
    socCode: null, explicitMention: null
  };
}

// ── Salary reason builder (shared between tiers) ──────────────────────────────
function buildSalaryReason(salary, salaryOk) {
  if (!salary) return 'Salary not stated — verify threshold manually.';
  const range = parseSalary(salary);
  if (!range) return `Salary "${salary}" — could not parse for threshold comparison.`;
  return salaryOk
    ? `✓ Salary ${salary} meets the £${THRESHOLDS.general.toLocaleString()} threshold.`
    : `⚠ Salary ${salary} may be below the £${THRESHOLDS.general.toLocaleString()} threshold — check the SOC code.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual employer name search (last-resort fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a register check with a user-supplied employer name.
 * Used when automatic extraction fails (e.g. unsupported site) or when the
 * user wants to search by a different / corrected name.
 *
 * @param {string}      employerName - name typed by the user
 * @param {object}      jobData      - current job data (may have empty .company)
 * @param {AbortSignal} [signal]
 * @param {function}    [onProgress]
 * @returns {Promise<SponsorshipResult>}
 */
export async function checkManualEmployer(employerName, jobData, signal, onProgress) {
  const name = (employerName ?? '').trim();
  if (!name) throw new Error('Please enter an employer name to search.');

  // Build a jobData with the user-supplied employer name
  const overrideData = { ...(jobData ?? {}), company: name };

  onProgress?.('Checking register with provided employer name…');
  const register = await ensureRegister(onProgress);
  const onReg    = checkEmployerOnRegister(name, register);
  const salaryOk = salaryMeetsThreshold(jobData?.salary ?? '');
  const sources  = ['https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers'];

  // Exact / normalised match
  if (register && onReg === true) {
    const reasons = [
      `✓ "${name}" is on the UK Register of Licensed Sponsors.`,
      buildSalaryReason(jobData?.salary ?? '', salaryOk)
    ].filter(Boolean);
    return {
      status:               salaryOk === false ? 'UNCERTAIN' : 'LIKELY_SPONSORABLE',
      reasons:              salaryOk === false
        ? [...reasons, 'Check the role-specific SOC code — NHS health roles may qualify for the lower Health and Care Worker threshold.']
        : reasons,
      sourceUrls:           sources,
      employerOnRegister:   true,
      salaryThreshold:      THRESHOLDS.general,
      salaryMeetsThreshold: salaryOk,
      socCode: null, explicitMention: null
    };
  }

  // Not found — offer similar names for selection
  if (register && (onReg === false || onReg === null)) {
    const similar = findSimilarEmployers(name, register);
    if (similar.length > 0) {
      return {
        status:             'NEEDS_SELECTION',
        reasons:            [`"${name}" was not found exactly. Select the correct organisation below:`],
        similarEmployers:   similar,
        sourceUrls:         sources,
        employerOnRegister: null,
        salaryThreshold:    THRESHOLDS.general,
        salaryMeetsThreshold: salaryOk,
        socCode: null, explicitMention: null
      };
    }
  }

  // No similar names or register unavailable — fall through to Tier 3
  return runTier3AgenticSearch(overrideData, register, salaryOk, signal, onProgress);
}

// ─────────────────────────────────────────────────────────────────────────────
// Document checklist cross-reference
// ─────────────────────────────────────────────────────────────────────────────

export async function getSponsorshipChecklistStatus(verdict) {
  const readiness = await getSponsorshipReadiness();
  return { ...readiness, verdictStatus: verdict.status };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict badge helper (used by popup UI)
// ─────────────────────────────────────────────────────────────────────────────

export function verdictBadge(status) {
  return {
    LIKELY_SPONSORABLE:   { label: 'Likely Sponsorable',    colour: '#00703c' },
    UNCERTAIN:            { label: 'Uncertain',              colour: '#f47738' },
    UNLIKELY_SPONSORABLE: { label: 'Unlikely Sponsorable',  colour: '#d4351c' },
    NEEDS_SELECTION:      { label: 'Select Organisation',   colour: '#005eb8' }
  }[status] ?? { label: 'Unknown', colour: '#888888' };
}
