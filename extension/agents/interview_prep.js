/**
 * Agent 8 — Interview Prep Coach (popup/prep-page module)
 *
 * Strict responsibility: Interview preparation based on saved job applications.
 * Nothing else.
 *
 * Public API:
 *   generatePrepSession(appId, signal)         → Promise<PrepSession>
 *   getPrepProgress(appId)                     → Promise<PrepProgress>
 *   savePrepProgress(appId, progress)          → Promise
 *   askFollowUp(question, context, signal)     → Promise<string>
 *   streamFollowUp(question, context, opts)    → Promise<string>
 */

import { callClaude, streamClaude, buildSystemBlocks, parseJSON }
  from '../utils/claude_api.js';
import { getActiveCV }
  from './cv_engine.js';
import { getApplications }
  from './job_tracker.js';

// ── Storage keys ──────────────────────────────────────────────────────────────

const prepKey = appId => `interviewPrep-${appId}`;

// ── System prompts ────────────────────────────────────────────────────────────

const PREP_INSTRUCTIONS = `\
You are an expert NHS interview coach with deep knowledge of UK healthcare recruitment.
Generate a complete, tailored interview preparation session for the candidate.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "questions": [
    {
      "id": "<unique-slug>",
      "category": "Clinical" | "Competency" | "NHS Values" | "Scenario" | "Motivational",
      "question": "<full question text>",
      "suggestedAnswer": "<STAR-format answer using candidate's CV and experience>",
      "notes": "<interviewer probe tip or key point — 1 sentence>"
    }
  ],
  "researchPoints": [
    "<specific thing to research about this employer or role>"
  ],
  "redFlags": [
    {
      "issue": "<potential weak point the interviewer might probe>",
      "suggestedResponse": "<how to address it confidently>"
    }
  ]
}

Rules:
- Generate 8-12 questions, spread across categories
- For NHS roles: always include 2-3 NHS Values questions with specific value examples
- STAR format: Situation, Task, Action, Result — use real examples from the CV
- Never fabricate experience not in the CV
- UK English. NHS context throughout.`;

const RESOURCES_INSTRUCTIONS = `\
You are an NHS career expert. Given the gaps and role requirements for this specific job,
suggest specific free or low-cost study resources the candidate should review before their interview.

Return ONLY valid JSON:
{
  "resources": [
    {
      "title": "<resource name>",
      "url": "<URL if confident it is correct — omit if unsure>",
      "category": "NHS e-Learning" | "Clinical Guideline" | "Professional Body" | "Free Course" | "Book",
      "relevance": "<why this is important for this specific role — 1 sentence>"
    }
  ]
}

Only include resources you have high confidence actually exist. Prefer well-known sources:
NHS e-Learning for Healthcare, NICE guidelines, RCN, HCPC, BPS, Skills for Health, FutureLearn NHS.`;

// ── Generate prep session ─────────────────────────────────────────────────────

/**
 * @typedef {object} PrepSession
 * @property {string}   appId
 * @property {Array}    questions       - [{ id, category, question, suggestedAnswer, notes }]
 * @property {string[]} researchPoints
 * @property {Array}    redFlags        - [{ issue, suggestedResponse }]
 * @property {Array}    resources       - [{ title, url, category, relevance }]
 */

/**
 * Generates a full tailored interview prep session for a saved application.
 *
 * @param {string}      appId
 * @param {AbortSignal} [signal]
 * @returns {Promise<PrepSession>}
 */
export async function generatePrepSession(appId, signal) {
  const [applications, cv] = await Promise.all([getApplications(), getActiveCV()]);
  const app = applications.find(a => a.id === appId);
  if (!app) throw new Error('Application not found in tracker.');
  if (!cv)  throw new Error('No active CV set. Please upload and select a CV in Settings.');

  // Stored document text (cover letter / supporting statement used)
  let docText = '';
  try {
    const { savedDocs = [] } = await chrome.storage.local.get('savedDocs');
    const doc = savedDocs.find(d => d.label?.includes(app.jobTitle));
    if (doc) docText = doc.text;
  } catch (_) {}

  const contextBlock = [
    `JOB TITLE: ${app.jobTitle}`,
    `EMPLOYER: ${app.companyName}`,
    `JOB URL: ${app.jobSiteUrl}`,
    docText ? `SUPPORTING STATEMENT / COVER LETTER USED:\n${docText.slice(0, 2000)}` : ''
  ].filter(Boolean).join('\n\n');

  const system = buildSystemBlocks([
    { text: PREP_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true }
  ]);

  // Run main prep session and resources in parallel
  const [prepRaw, resourcesRaw] = await Promise.all([
    callClaude({
      model:     'sonnet',
      system,
      messages:  [{ role: 'user', content: `${contextBlock}\n\nGenerate the full interview prep session JSON now.` }],
      maxTokens: 4000,
      signal
    }),
    callClaude({
      model:     'sonnet',
      system:    buildSystemBlocks(RESOURCES_INSTRUCTIONS),
      messages:  [{ role: 'user', content: `${contextBlock}\n\nSuggest study resources JSON now.` }],
      maxTokens: 1000,
      signal
    }).catch(() => '{"resources":[]}')
  ]);

  const prep      = parseJSON(prepRaw);
  const resources = parseJSON(resourcesRaw);

  const session = {
    appId,
    questions:     (prep.questions      || []).map(q => ({ ...q, practised: false })),
    researchPoints:(prep.researchPoints || []).map(r => ({ text: r, researched: false })),
    redFlags:      (prep.redFlags       || []).map(f => ({ ...f, prepared: false })),
    resources:     resources.resources  || [],
    generatedAt:   new Date().toISOString()
  };

  // Save session to storage
  await chrome.storage.local.set({ [prepKey(appId)]: session });

  return session;
}

// ── Progress persistence ──────────────────────────────────────────────────────

/**
 * Returns stored progress for an application, or null if never generated.
 * @param {string} appId
 * @returns {Promise<PrepSession|null>}
 */
export async function getPrepProgress(appId) {
  const r = await chrome.storage.local.get(prepKey(appId));
  return r[prepKey(appId)] ?? null;
}

/**
 * Saves progress updates (practised flags, researched flags, etc.)
 * Merges into existing session rather than replacing.
 * @param {string} appId
 * @param {object} updates - partial PrepSession object
 */
export async function savePrepProgress(appId, updates) {
  const existing = await getPrepProgress(appId) ?? {};
  await chrome.storage.local.set({ [prepKey(appId)]: { ...existing, ...updates } });
}

// ── Live follow-up chat ───────────────────────────────────────────────────────

const FOLLOWUP_SYSTEM = `\
You are an interview coach. The candidate is preparing for a healthcare interview.
Given their current answer to an interview question and their follow-up request,
provide an improved or clarified answer. Keep it concise and practical.
Use their actual experience from the CV context provided.
UK English.`;

/**
 * Handles a live follow-up question about a specific interview answer.
 * Streaming version — calls opts.onChunk for each text chunk.
 *
 * @param {string}   followUpQuestion  - user's request, e.g. "Make this shorter"
 * @param {object}   context           - { question, currentAnswer, cvExcerpt }
 * @param {object}   opts              - { onChunk, signal }
 * @returns {Promise<string>}          - full revised answer
 */
export async function streamFollowUp(followUpQuestion, context, opts = {}) {
  const system   = buildSystemBlocks(FOLLOWUP_SYSTEM);
  const messages = [{
    role:    'user',
    content: [
      `INTERVIEW QUESTION: ${context.question}`,
      `CURRENT ANSWER: ${context.currentAnswer}`,
      context.cvExcerpt ? `RELEVANT CV EXCERPT: ${context.cvExcerpt}` : '',
      ``,
      `CANDIDATE REQUEST: ${followUpQuestion}`
    ].filter(Boolean).join('\n\n')
  }];

  const { onChunk, signal } = opts;

  if (typeof onChunk === 'function') {
    return streamClaude({ model: 'sonnet', system, messages, maxTokens: 600, signal, onChunk });
  }
  return callClaude({ model: 'sonnet', system, messages, maxTokens: 600, signal });
}
