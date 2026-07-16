/**
 * Agent 1 — CV Engine
 *
 * Strict responsibility: CV storage, parsing, matching, optimisation,
 * and document generation. Nothing else.
 *
 * Public API consumed by other agents:
 *   getActiveCV()                    → { id, label, text } | null
 *   matchCV(jobText)                 → MatchResult
 *   optimiseCV(jobText)              → OptimiseResult
 *   generateStatement(jobText, opts) → string (streamed via opts.onChunk)
 *   generateCoverLetter(jobText, opts) → string (streamed via opts.onChunk)
 *
 * Popup-facing functions:
 *   getCVList()
 *   uploadCV(file | text, label)
 *   setActiveCV(id)
 *   deleteCV(id)
 *   exportCVData() / importCVData(data)
 */

import { callClaude, streamClaude, parseJSON, buildSystemBlocks } from '../utils/claude_api.js';

// ── Storage keys ──────────────────────────────────────────────────────────────
const KEY_CVS        = 'cvs';
const KEY_ACTIVE_CV  = 'activeCVId';
const KEY_ADDITIONAL = 'additionalCVDetails';

// ── Additional CV details ─────────────────────────────────────────────────────
// Optional free-text supplement for real experience/skills not present in the
// uploaded CV. Applied alongside the active CV wherever a consumer opts in.

/** @returns {Promise<string>} the saved additional details, or ''. */
export async function getAdditionalDetails() {
  const r = await chrome.storage.local.get(KEY_ADDITIONAL);
  return r[KEY_ADDITIONAL] ?? '';
}

/** Saves (or clears) the additional CV details. */
export async function setAdditionalDetails(text) {
  await chrome.storage.local.set({ [KEY_ADDITIONAL]: (text ?? '').trim() });
}

// ── PDF.js initialisation ─────────────────────────────────────────────────────

let _pdfJsReady = false;

function ensurePdfJs() {
  if (_pdfJsReady) return;
  if (!globalThis.pdfjsLib) {
    throw new Error('pdf.js not loaded. Ensure lib/pdf.min.js is included in popup.html.');
  }
  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc =
    chrome.runtime.getURL('lib/pdf.worker.min.js');
  _pdfJsReady = true;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

/**
 * Extracts all text from a PDF file.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<string>}
 */
async function parsePDF(arrayBuffer) {
  ensurePdfJs();
  const loadingTask = globalThis.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
  const pdf         = await loadingTask.promise;
  const pageTexts   = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Join items; add a space between items that lack trailing spaces
    const text = content.items
      .map(item => item.str)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    pageTexts.push(text);
  }

  return pageTexts.join('\n\n').trim();
}

/**
 * Extracts all text from a DOCX file using mammoth.js.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<string>}
 */
async function parseDOCX(arrayBuffer) {
  if (!globalThis.mammoth) {
    throw new Error('mammoth.js not loaded. Ensure lib/mammoth.min.js is included in popup.html.');
  }
  const result = await globalThis.mammoth.extractRawText({ arrayBuffer });
  if (result.messages?.length) {
    console.warn('[cv_engine] mammoth warnings:', result.messages);
  }
  return result.value.trim();
}

/**
 * Reads a File object and returns its content as an ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Parse a CV from a File object or plain text string.
 * Returns the extracted text.
 * @param {File|string} input
 * @returns {Promise<string>}
 */
export async function parseCV(input) {
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t) throw new Error('CV text cannot be empty.');
    return t;
  }

  if (!(input instanceof File)) {
    throw new Error('Input must be a File or a string.');
  }

  const name = input.name.toLowerCase();
  const buf  = await readFileAsBuffer(input);

  if (name.endsWith('.pdf')) {
    const text = await parsePDF(buf);
    if (!text) throw new Error('No text could be extracted from this PDF. The file may be image-only or protected.');
    return text;
  }

  if (name.endsWith('.docx')) {
    const text = await parseDOCX(buf);
    if (!text) throw new Error('No text could be extracted from this DOCX file.');
    return text;
  }

  if (name.endsWith('.doc')) {
    throw new Error('.doc (old Word format) is not supported. Please save the file as .docx or copy-paste the text.');
  }

  if (name.endsWith('.txt')) {
    return new TextDecoder().decode(buf).trim();
  }

  throw new Error(`Unsupported file type: ${input.name}. Please upload a .pdf, .docx, or .txt file.`);
}

// ── CV Storage ────────────────────────────────────────────────────────────────

/** @returns {Promise<Array<{id,label,text,dateAdded}>>} */
export async function getCVList() {
  const r = await chrome.storage.local.get(KEY_CVS);
  return r[KEY_CVS] ?? [];
}

async function saveCVList(list) {
  await chrome.storage.local.set({ [KEY_CVS]: list });
}

/**
 * Stores a parsed CV.
 * @param {string} text  - full CV text
 * @param {string} label - user-supplied label
 * @returns {Promise<{id,label,text,dateAdded}>} - the saved entry
 */
export async function storeCV(text, label) {
  if (!text?.trim()) throw new Error('CV text is empty — nothing was saved.');
  if (!label?.trim()) throw new Error('A label is required (e.g. "NHS Band 6").');

  const list  = await getCVList();
  const entry = {
    id:        crypto.randomUUID(),  // Upgrade #6
    label:     label.trim(),
    text:      text.trim(),
    dateAdded: new Date().toISOString()
  };
  list.push(entry);
  await saveCVList(list);

  // If this is the first CV, make it active automatically
  const activeId = await getActiveCVId();
  if (!activeId) await setActiveCV(entry.id);

  return entry;
}

/**
 * Parse a file/text input and store it. Returns the saved entry.
 * @param {File|string} input
 * @param {string} label
 */
export async function uploadCV(input, label) {
  const text = await parseCV(input);
  return storeCV(text, label);
}

async function getActiveCVId() {
  const r = await chrome.storage.local.get(KEY_ACTIVE_CV);
  return r[KEY_ACTIVE_CV] ?? null;
}

/** @returns {Promise<{id,label,text,dateAdded}|null>} */
export async function getActiveCV() {
  const id   = await getActiveCVId();
  if (!id) return null;
  const list = await getCVList();
  return list.find(cv => cv.id === id) ?? null;
}

/** @param {string} id */
export async function setActiveCV(id) {
  await chrome.storage.local.set({ [KEY_ACTIVE_CV]: id });
}

/**
 * Delete a CV by id.
 * If the deleted CV was active, the most recently added remaining CV is made active.
 * @param {string} id
 */
export async function deleteCV(id) {
  let list = await getCVList();
  list = list.filter(cv => cv.id !== id);
  await saveCVList(list);

  const activeId = await getActiveCVId();
  if (activeId === id) {
    const next = list[list.length - 1];
    await chrome.storage.local.set({ [KEY_ACTIVE_CV]: next?.id ?? null });
  }
}

/** Rename the label of an existing CV. */
export async function renameCV(id, newLabel) {
  const list = await getCVList();
  const cv   = list.find(c => c.id === id);
  if (!cv) throw new Error('CV not found.');
  cv.label = newLabel.trim();
  await saveCVList(list);
}

// ── Claude prompts ────────────────────────────────────────────────────────────

const MATCH_INSTRUCTIONS = `\
You are an expert NHS recruitment specialist and CV analyst.
Given the candidate's CV and a job description, analyse how well the CV matches the role.

Return ONLY a valid JSON object with this exact structure — no markdown fences, no extra text:
{
  "score": <integer 0-100 representing overall match percentage>,
  "fullMatches": [
    { "requirement": "<requirement from JD>", "evidence": "<exact quote or paraphrase from CV>" }
  ],
  "partialMatches": [
    { "requirement": "<requirement from JD>", "partialEvidence": "<what the CV shows>", "gap": "<what is missing>" }
  ],
  "gaps": [
    { "requirement": "<requirement from JD>", "reason": "<why the CV does not meet it>" }
  ]
}

Scoring guide:
- 90-100: CV strongly meets almost all requirements
- 70-89:  CV meets most requirements with a few gaps
- 50-69:  CV meets key requirements but has notable gaps
- 30-49:  CV meets some requirements but has significant gaps
- 0-29:   CV is a poor match for this role

Be specific and accurate. Only mark as fullMatch if there is clear evidence in the CV.`;

const OPTIMISE_INSTRUCTIONS = `\
You are an expert UK CV writer with ATS (Applicant Tracking System) optimisation expertise.
Rewrite the provided CV to better match the job description, maximising both ATS pass rates and human readability.

STRICT RULES — breaking these is not permitted:
1. ONLY use information present in the original CV. Never invent a qualification, role, skill, or achievement.
2. You may reorder, rephrase, and promote existing content — but the underlying facts must exist in the CV.
3. If a requirement cannot be met from the CV's existing content, list it in unfillableGaps — do not add it.
4. Adjust terminology to match the job description's exact language where the underlying experience exists.
5. Strengthen the professional summary to directly mirror the job's key requirements.

ATS COMPATIBILITY RULES:
6. Use only standard ATS-readable section headings: Professional Summary, Work Experience, Education, Skills, Certifications, Achievements.
7. Place the most critical JD keywords in the Professional Summary and in the opening line of each relevant role.
8. Do not use tables, columns, text boxes, headers/footers, or special characters that ATS parsers cannot read.
9. Quantify achievements wherever the original CV contains numeric data (percentages, £ figures, team sizes, timeframes).

FORMAT RULE — apply the FORMAT value from the user message:
- "star": write all experience bullets using STAR structure (Situation → Task → Action → Result), keeping each bullet concise.
- "standard": write concise achievement-led bullets beginning with a strong past-tense action verb.
- "auto": choose the better format for the role — STAR for competency-based, public-sector, and NHS roles; standard for commercial/private-sector roles. Explain your choice in formatReason.

Return ONLY a valid JSON object — no markdown fences, no extra text:
{
  "optimisedCV": "<full rewritten CV text>",
  "recommendedFormat": "star" | "standard",
  "formatReason": "<one sentence explaining why this format suits the role>",
  "changes": [
    {
      "type": "reorder|rephrase|promote|terminology|summary|ats|star",
      "original": "<original text from the CV>",
      "changed": "<new text>",
      "reason": "<why this improves ATS score or match>"
    }
  ],
  "unfillableGaps": [
    "<requirement from JD that cannot be filled from the CV's real content>"
  ]
}`;

const STATEMENT_INSTRUCTIONS = `\
You are an expert NHS application writer. Generate a professional NHS-style supporting statement.

Format requirements:
- Structured paragraphs, 600-800 words
- Cover: why the candidate wants this specific role, their relevant clinical/professional experience,
  how they demonstrate NHS values (care, compassion, commitment to quality, improving lives,
  working together, everyone counts), and their commitment to the team and organisation
- Use first person ("I have demonstrated...")
- UK English spelling and NHS terminology
- Do NOT use bullet points — flowing prose only
- Do NOT include a heading like "Supporting Statement" — start directly with the content

CRITICAL: Only use information present in the candidate's CV. Do not fabricate experience.`;

const COVER_LETTER_INSTRUCTIONS = `\
You are an expert UK careers advisor. Generate a professional cover letter.

Format requirements:
- Formal UK business letter format
- 3-4 paragraphs, 250-400 words
- Opening: express interest in the specific role and organisation
- Middle: highlight 2-3 strongest matching qualifications/experiences from the CV
- Closing: confirm availability for interview, express enthusiasm
- UK English spelling

Do NOT include a date, address block, or "Dear [Name]" — start from "Dear Hiring Manager" or
"Dear [Job Title] Recruitment Team" if the role title is known.

CRITICAL: Only use information present in the candidate's CV. Do not fabricate experience.`;

// ── Match Score & Gap Analysis ────────────────────────────────────────────────

/**
 * @typedef {object} MatchResult
 * @property {number}   score
 * @property {Array}    fullMatches     - [{ requirement, evidence }]
 * @property {Array}    partialMatches  - [{ requirement, partialEvidence, gap }]
 * @property {Array}    gaps            - [{ requirement, reason }]
 */

/**
 * Analyses the active CV against a job description.
 * @param {string}      jobText
 * @param {AbortSignal} [signal]
 * @returns {Promise<MatchResult>}
 */
export async function matchCV(jobText, signal) {
  const cv = await getActiveCV();
  if (!cv) throw new Error('No active CV set. Please upload and select a CV first.');
  if (!jobText?.trim()) throw new Error('Job description text is required.');

  // cache:true on both blocks so repeated calls for the same CV hit the prompt cache (reduces cost)
  const system = buildSystemBlocks([
    { text: MATCH_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true }
  ]);

  const text = await callClaude({
    model:     'sonnet',
    system,
    // 8192 — a detailed job (many requirements × evidence strings) can push the
    // fullMatches/partialMatches/gaps JSON past a smaller cap, truncating it mid-object
    // and breaking JSON.parse. Matches the optimiseCV ceiling for the same reason.
    messages:  [{ role: 'user', content: `JOB DESCRIPTION:\n\n${jobText}\n\nReturn the JSON analysis.` }],
    maxTokens: 8192,
    signal
  });

  const result = parseJSON(text);

  // Validate shape
  if (typeof result.score !== 'number') throw new Error('Unexpected response format from Claude. Please try again.');

  return {
    score:          Math.max(0, Math.min(100, Math.round(result.score))),
    fullMatches:    result.fullMatches    ?? [],
    partialMatches: result.partialMatches ?? [],
    gaps:           result.gaps           ?? []
  };
}

// ── CV Optimisation ───────────────────────────────────────────────────────────

/**
 * @typedef {object} OptimiseResult
 * @property {string}   optimisedText
 * @property {Array}    changes         - [{ type, original, changed, reason }]
 * @property {string[]} unfillableGaps  - requirements that cannot be filled from the CV
 * @property {string}   originalLabel
 * @property {string}   savedId         - id of the newly saved optimised CV (after user approves)
 */

/**
 * Generates an optimised version of the active CV for the given job.
 * The original CV is never overwritten — the optimised version is returned for
 * user review and saved only after explicit approval (via saveOptimisedCV).
 *
 * @param {string}      jobText
 * @param {AbortSignal} [signal]
 * @returns {Promise<OptimiseResult>}
 */
export async function optimiseCV(jobText, signal, format = 'auto') {
  const cv = await getActiveCV();
  if (!cv) throw new Error('No active CV set.');
  if (!jobText?.trim()) throw new Error('Job description text is required.');

  const system = buildSystemBlocks([
    { text: OPTIMISE_INSTRUCTIONS, cache: true },
    { text: `ORIGINAL CV:\n\n${cv.text}`, cache: true }
  ]);

  const text = await callClaude({
    model:     'sonnet',
    system,
    messages:  [{ role: 'user', content: `JOB DESCRIPTION:\n\n${jobText}\n\nFORMAT: ${format}\n\nReturn the JSON result.` }],
    maxTokens: 8192, // raised from 4096 — a full CV rewrite JSON can exceed 4096 tokens causing silent truncation
    signal
  });

  const result = parseJSON(text);
  if (!result.optimisedCV) throw new Error('Optimisation returned an unexpected format. Please try again.');

  return {
    optimisedText:     result.optimisedCV.trim(),
    changes:           result.changes           ?? [],
    unfillableGaps:    result.unfillableGaps    ?? [],
    recommendedFormat: result.recommendedFormat ?? format,
    formatReason:      result.formatReason      ?? '',
    originalLabel:     cv.label
  };
}

/**
 * Saves an approved optimised CV as a new entry (never overwrites the original).
 * @param {string} optimisedText - the (possibly user-edited) optimised CV text
 * @param {string} jobTitle      - used to label the saved version
 * @returns {Promise<{id,label,text,dateAdded}>}
 */
export async function saveOptimisedCV(optimisedText, jobTitle) {
  const label = `${jobTitle || 'Optimised'} (${new Date().toLocaleDateString('en-GB')})`;
  return storeCV(optimisedText, label);
}

// ── Document Generation ───────────────────────────────────────────────────────

/**
 * Generates an NHS supporting statement (streamed).
 *
 * @param {string}      jobText
 * @param {object}      [opts]
 * @param {Function}    [opts.onChunk]  - called with each text chunk for live display
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} - full statement text
 */
export async function generateStatement(jobText, opts = {}) {
  const cv = await getActiveCV();
  if (!cv) throw new Error('No active CV set.');

  const { onChunk, signal, briefContext } = opts;
  const system = buildSystemBlocks([
    { text: STATEMENT_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true }
  ]);
  // Optional alignment brief (from the Application Strategist) tailors the statement to
  // the job's selection criteria and the candidate's confirmed extra experience.
  const briefBlock = briefContext ? `${briefContext}\n\n` : '';
  const messages = [{ role: 'user', content: `JOB DESCRIPTION:\n\n${jobText}\n\n${briefBlock}Generate the supporting statement now.` }];

  if (typeof onChunk === 'function') {
    return streamClaude({ model: 'sonnet', system, messages, maxTokens: 1500, signal, onChunk });
  }
  return callClaude({ model: 'sonnet', system, messages, maxTokens: 1500, signal });
}

/**
 * Generates a formal cover letter (streamed).
 *
 * @param {string}      jobText
 * @param {object}      [opts]
 * @param {Function}    [opts.onChunk]  - called with each text chunk for live display
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} - full cover letter text
 */
export async function generateCoverLetter(jobText, opts = {}) {
  const cv = await getActiveCV();
  if (!cv) throw new Error('No active CV set.');

  const { onChunk, signal, briefContext } = opts;
  const system = buildSystemBlocks([
    { text: COVER_LETTER_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true }
  ]);
  // Optional alignment brief (from the Application Strategist) tailors the letter to the
  // job's selection criteria and the candidate's confirmed extra experience.
  const briefBlock = briefContext ? `${briefContext}\n\n` : '';
  const messages = [{ role: 'user', content: `JOB DESCRIPTION:\n\n${jobText}\n\n${briefBlock}Generate the cover letter now.` }];

  if (typeof onChunk === 'function') {
    return streamClaude({ model: 'sonnet', system, messages, maxTokens: 800, signal, onChunk });
  }
  return callClaude({ model: 'sonnet', system, messages, maxTokens: 800, signal });
}

// ── Backup / Restore ─────────────────────────────────────────────────────────

/** Returns all CV data for backup. */
export async function exportCVData() {
  const [list, activeId] = await Promise.all([getCVList(), getActiveCVId()]);
  return { cvs: list, activeCVId: activeId };
}

/** Restores CV data from a backup object. */
export async function importCVData({ cvs, activeCVId }) {
  if (Array.isArray(cvs)) await saveCVList(cvs);
  if (activeCVId)         await chrome.storage.local.set({ [KEY_ACTIVE_CV]: activeCVId });
}
