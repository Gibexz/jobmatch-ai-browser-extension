/**
 * Agent 10 — Application Strategist
 *
 * Strict responsibility: Understanding job documents and aligning the candidate's
 * real experience to them. Produces one compact "alignment brief" per job. Nothing else.
 *
 * Reuses Agent 1 (CV Engine) for CV/PDF/DOCX parsing and storage — never re-implements it.
 * Never fills forms (that is Agent 2) and never overwrites the original CV.
 *
 * Public API:
 *   buildAlignmentBrief(jobId, jobFiles, opts) → AlignmentBrief
 *   getAlignmentBrief(jobId)                   → AlignmentBrief | null
 *   listAlignmentBriefs()                      → Array
 *   deleteAlignmentBrief(jobId)                → void
 */

import { callClaude, buildSystemBlocks, parseJSON } from '../utils/claude_api.js';
import { parseCV, storeCV, getActiveCV }           from './cv_engine.js';

const KEY_BRIEFS    = 'jm_alignmentBriefs';
// Cap the combined document text so a large JD pack can't blow the token budget.
const MAX_DOC_CHARS = 60000;

// ── Storage ─────────────────────────────────────────────────────────────────

async function getBriefs() {
  const r = await chrome.storage.local.get(KEY_BRIEFS);
  return r[KEY_BRIEFS] ?? [];
}

async function saveBriefs(list) {
  await chrome.storage.local.set({ [KEY_BRIEFS]: list });
}

/** @returns {Promise<Array>} all stored alignment briefs, newest first. */
export async function listAlignmentBriefs() {
  return getBriefs();
}

/** @returns {Promise<object|null>} the brief for a given job, or null. */
export async function getAlignmentBrief(jobId) {
  if (!jobId) return null;
  const list = await getBriefs();
  return list.find(b => b.jobId === jobId) ?? null;
}

/** Removes the brief for a given job. */
export async function deleteAlignmentBrief(jobId) {
  const list = await getBriefs();
  await saveBriefs(list.filter(b => b.jobId !== jobId));
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const STRATEGIST_INSTRUCTIONS = `\
You are an expert NHS and UK recruitment shortlisting specialist.
You are given a candidate's CV and the official job documents (Job Description and/or
Person Specification). Extract the selection criteria and map the candidate's REAL
experience to each one, exactly as a shortlisting panel would.

ABSOLUTE RULE — NEVER FABRICATE:
Evidence for a criterion must come from the candidate's actual CV. If a criterion is not
supported by the CV, mark its status "gap" with an empty evidence string. Never invent a
qualification, role, skill, or achievement to satisfy a criterion.

For each criterion:
- "text": the criterion, quoted or closely paraphrased from the documents
- "level": "essential" or "desirable" (use the document's own designation)
- "category": one of Qualifications, Experience, Skills, Values, Other
- "status": "met" (clear CV evidence), "partial" (some evidence, with a gap), or "gap" (none)
- "evidence": the specific CV evidence, or "" if a gap
- "talkingPoint": a short suggested phrasing for an application answer, grounded ONLY in the CV

Also produce:
- "keywords": key ATS terms from the documents the candidate should echo
- "positioning": 2-3 sentences on the strongest overall angle for this application
- "gaps": the genuine unmet essential/desirable criteria (never invented away)

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "criteria": [
    { "text": "", "level": "essential|desirable",
      "category": "Qualifications|Experience|Skills|Values|Other",
      "status": "met|partial|gap", "evidence": "", "talkingPoint": "" }
  ],
  "keywords": [],
  "positioning": "",
  "gaps": []
}`;

// ── Build ───────────────────────────────────────────────────────────────────

/**
 * Ingests job documents (+ optional tailored CV), extracts the selection criteria,
 * maps the CV's real evidence to each, and stores a compact alignment brief for the job.
 *
 * @param {string}      jobId    - id of the analysed job this brief belongs to
 * @param {FileList|File[]} jobFiles - JD / person-spec documents (PDF/DOCX/TXT)
 * @param {object}      [opts]
 * @param {File}        [opts.cvFile]   - optional tailored CV; saved as a NEW labelled version
 * @param {string}      [opts.cvLabel]  - label for the saved tailored CV
 * @param {string}      [opts.jobTitle]
 * @param {string}      [opts.company]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} the stored alignment brief
 */
export async function buildAlignmentBrief(jobId, jobFiles, opts = {}) {
  const files = Array.from(jobFiles ?? []);
  if (!files.length) {
    throw new Error('Please upload at least one job document (the Job Description or Person Specification).');
  }

  // Parse every job document by REUSING Agent 1's parser (PDF / DOCX / TXT)
  const docs = [];
  for (const f of files) {
    const text = await parseCV(f);
    docs.push({
      name:  f.name,
      type:  (f.name.split('.').pop() || '').toLowerCase(),
      text:  text || '',
      chars: (text || '').length
    });
  }

  // Resolve which CV to map against
  let cvText, cvLabel;
  if (opts.cvFile) {
    const t     = await parseCV(opts.cvFile);
    const label = opts.cvLabel?.trim() ||
      `Tailored — ${opts.jobTitle || 'Application'} (${new Date().toLocaleDateString('en-GB')})`;
    // Saved as a NEW labelled version — the original CV is never overwritten
    const saved = await storeCV(t, label);
    cvText  = saved.text;
    cvLabel = saved.label;
  } else {
    const active = await getActiveCV();
    if (!active) throw new Error('No CV available. Upload a tailored CV here, or set an active CV in Settings.');
    cvText  = active.text;
    cvLabel = active.label;
  }

  // Assemble the (bounded) documents block for the prompt
  let docsBlock = docs.map(d => `=== DOCUMENT: ${d.name} ===\n${d.text}`).join('\n\n');
  if (docsBlock.length > MAX_DOC_CHARS) docsBlock = docsBlock.slice(0, MAX_DOC_CHARS);

  const system = buildSystemBlocks([
    { text: STRATEGIST_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cvText}`, cache: true }
  ]);

  const raw = await callClaude({
    model:     'sonnet',
    system,
    messages:  [{ role: 'user', content: `JOB DOCUMENTS:\n\n${docsBlock}\n\nReturn the alignment brief JSON now.` }],
    maxTokens: 8192, // documents + criteria mapping can be large; same truncation guard as the other calls
    signal:    opts.signal
  });

  const parsed = parseJSON(raw);

  const brief = {
    id:          crypto.randomUUID(),
    jobId:       jobId ?? null,
    jobTitle:    opts.jobTitle || '',
    company:     opts.company || '',
    createdAt:   new Date().toISOString(),
    cvLabel,
    cvText,                                    // kept for the refinement chat; not shown in the UI
    sourceDocs:  docs.map(d => ({ name: d.name, type: d.type, chars: d.chars })), // metadata only — no binaries stored
    // Each criterion gets a stable id so the refinement chat can target it precisely
    criteria:    (Array.isArray(parsed.criteria) ? parsed.criteria : [])
                   .map(c => ({ id: crypto.randomUUID(), ...c })),
    keywords:    parsed.keywords    ?? [],
    positioning: parsed.positioning ?? '',
    gaps:        parsed.gaps        ?? [],
    conversation: [],                          // refinement chat history
    supplementary: []                          // real experience the candidate added beyond the CV
  };

  // Persist — replace any existing brief for the same job, keep newest first
  const list = await getBriefs();
  const next = brief.jobId ? list.filter(b => b.jobId !== brief.jobId) : list.slice();
  next.unshift(brief);
  await saveBriefs(next);

  return brief;
}

// ── Refinement chat ─────────────────────────────────────────────────────────

const CHAT_INSTRUCTIONS = `\
You are the Application Strategist in a refinement chat. The candidate is telling you about
real experience or skills they already have that may not have been captured in their CV.

Treat what they tell you as TRUE information about themselves — they are supplementing their
own record, not fabricating. Never invent anything they did not state.

You are given the current criteria (each with a number "n" and a status) and the
candidate's message. Update any criteria the new information genuinely now supports: raise
the status (gap -> partial -> met) as warranted, and set concrete evidence and a talking
point drawn from what they told you.

Rules:
- Reference each changed criterion by its exact "n" number.
- Only update criteria genuinely supported by what the candidate stated — do not inflate.
- If what they said is too vague to justify a change, ask ONE brief clarifying question in
  "reply" and leave the statuses unchanged until they confirm specifics.
- Keep "reply" short and conversational (2-4 sentences).

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "reply": "<short conversational reply>",
  "updates": [
    { "n": <criterion number>, "status": "met|partial|gap",
      "evidence": "<evidence from what they said>", "talkingPoint": "<suggested phrasing>" }
  ]
}`;

/**
 * Refinement chat: the candidate adds real experience, and any criteria it supports are
 * re-mapped (gap -> partial -> met). The conversation and additions are saved with the brief.
 *
 * @param {string}      jobId
 * @param {string}      userText - the experience/skill the candidate is adding
 * @param {AbortSignal} [signal]
 * @returns {Promise<{reply:string, brief:object}>}
 */
export async function chatRefineBrief(jobId, userText, signal) {
  const text = (userText ?? '').trim();
  if (!text) throw new Error('Type the experience you want to add.');

  const brief = await getAlignmentBrief(jobId);
  if (!brief) throw new Error('No alignment brief found for this job.');

  const convo = brief.conversation ?? [];

  // Compact view of the criteria for the prompt. Referenced by short index "n" —
  // models echo small integers reliably, whereas long UUIDs often come back altered.
  const criteriaView = brief.criteria.map((c, i) => ({
    n: i, text: c.text, level: c.level, status: c.status, evidence: c.evidence
  }));

  const system = buildSystemBlocks([
    { text: CHAT_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${brief.cvText || ''}`, cache: true }
  ]);

  const messages = [
    ...convo.map(m => ({ role: m.role, content: m.text })),
    { role: 'user', content:
      `CURRENT CRITERIA:\n${JSON.stringify(criteriaView, null, 2)}\n\n` +
      `CANDIDATE ADDS:\n${text}\n\nReturn the JSON response now.` }
  ];

  const raw    = await callClaude({ model: 'sonnet', system, messages, maxTokens: 4096, signal });
  const parsed = parseJSON(raw);

  // Apply any criterion updates by index "n"
  const updates = Array.isArray(parsed.updates) ? parsed.updates : [];
  for (const u of updates) {
    const idx = Number(u.n);
    if (!Number.isInteger(idx) || idx < 0 || idx >= brief.criteria.length) continue;
    const c = brief.criteria[idx];
    if (u.status)                                             c.status       = u.status;
    if (typeof u.evidence === 'string' && u.evidence)        c.evidence     = u.evidence;
    if (typeof u.talkingPoint === 'string' && u.talkingPoint) c.talkingPoint = u.talkingPoint;
  }

  const reply = parsed.reply ?? '';
  brief.conversation  = [
    ...convo,
    { role: 'user',      text,  ts: Date.now() },
    { role: 'assistant', text: reply, ts: Date.now() }
  ];
  brief.supplementary = [ ...(brief.supplementary ?? []), text ];

  // Persist the updated brief in place
  const list = await getBriefs();
  const idx  = list.findIndex(b => b.id === brief.id);
  if (idx >= 0) { list[idx] = brief; await saveBriefs(list); }

  return { reply, brief };
}
