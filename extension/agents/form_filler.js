/**
 * Agent 2 — Form Reader & Filler (popup module)
 *
 * Strict responsibility: Reading application form fields and injecting answers.
 * Nothing else.
 *
 * Dependencies (internal API):
 *   Agent 1 → getActiveCV()
 *   Agent 9 → getPersonalDetails()
 */

import { callClaude, buildSystemBlocks, parseJSON } from '../utils/claude_api.js';
import { getActiveCV }        from './cv_engine.js';
import { getPersonalDetails } from './personal_vault.js';

// ── Session state for per-field correction memory ─────────────────────────────
// Stored in chrome.storage.session so corrections survive popup open/close.

const SESSION_CORRECTIONS_KEY = 'formFillCorrections';

async function getSessionCorrections() {
  try {
    const r = await chrome.storage.session.get(SESSION_CORRECTIONS_KEY);
    return r[SESSION_CORRECTIONS_KEY] ?? {};
  } catch (_) { return {}; }
}

async function saveSessionCorrection(fieldKey, correctedValue) {
  const corrections = await getSessionCorrections();
  corrections[fieldKey] = correctedValue;
  try {
    await chrome.storage.session.set({ [SESSION_CORRECTIONS_KEY]: corrections });
  } catch (_) {}
}

export async function clearSessionCorrections() {
  try {
    await chrome.storage.session.remove(SESSION_CORRECTIONS_KEY);
  } catch (_) {}
}

// ── System prompt ─────────────────────────────────────────────────────────────

const FORM_FILL_INSTRUCTIONS = `\
You are an expert NHS job application assistant helping a candidate fill in their application form.
Given the list of form fields, the candidate's CV, personal details, and (optionally) the specific
job they are applying for, provide the best possible answer for each field that requires a text response.

RULES:
1. Only answer fields that require free-text input. For fields already handled by personal details
   (registration numbers, referees, right to work), use the provided personal details exactly.
2. Never invent qualifications, roles, skills, or achievements not in the CV.
3. For diversity/equal opportunities fields, use the candidate's stored preferences or leave as "".
4. For declaration checkboxes, set the answer to null — these must never be auto-filled.
5. If JOB CONTEXT is provided, tailor every answer to that specific role, its requirements, and
   its language. If JOB CONTEXT is absent, answer generally from the CV without inventing a role.

EXISTING CONTENT REVIEW:
- Some fields include an "existingContent" property — text the candidate has already written on the form.
- For each such field, assess the existing text and return a review in the "reviews" object:
  - "verdict": "keep" if the existing content is already strong, or "improve" if it can be strengthened.
  - "reason": one short sentence explaining the verdict.
- Still provide your best "answer" for these fields: an improved version when the verdict is "improve",
  or the existing text (lightly polished or unchanged) when the verdict is "keep".
- Only include a field in "reviews" if it had existingContent.

FORMAT RULE — apply the FORMAT value from the user message:
- "star": use STAR structure (Situation, Task, Action, Result) for ALL free-text answers, including motivation and experience questions. Label each element inline: "Situation: ... Task: ... Action: ... Result: ..."
- "narrative": write in clear, confident prose without STAR labels.
- "auto": use STAR for competency, behavioural, and NHS Values questions; use narrative for motivation, role-fit, and brief factual questions.

Also assess the job type and return:
- "recommendedFormat": "star" or "narrative" — whichever better suits this role
- "formatReason": one sentence explaining why (e.g. "This NHS role uses structured behavioural questions aligned to NHS Values.")

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "recommendedFormat": "star" | "narrative",
  "formatReason": "<one sentence>",
  "answers": {
    "<fieldId>|<fieldName>": "<suggested answer or null for declarations>"
  },
  "reviews": {
    "<fieldId>|<fieldName>": { "verdict": "keep" | "improve", "reason": "<one sentence>" }
  }
}`;

/** Builds the JOB CONTEXT prompt block; falls back to a "none" marker when no job is confirmed. */
function buildJobBlock(jobContext) {
  if (!jobContext || !(jobContext.title || jobContext.company)) {
    return 'JOB CONTEXT: none provided — answer generally from the CV, do not invent a specific role.';
  }
  return `JOB CONTEXT — the candidate is applying for this specific role:\n` +
    `Title: ${jobContext.title || ''}\n` +
    `Company: ${jobContext.company || ''}\n\n` +
    `${jobContext.descriptionText || ''}`.trim();
}

/** Maps a scanned field to the compact payload sent to Claude; flags pre-filled content for review. */
function toFieldPayload(f) {
  const entry = {
    key:         f.fieldKey || `${f.id}|${f.name}`,
    label:       f.label || f.placeholder || f.name,
    type:        f.type,
    options:     f.options?.map(o => o.text) ?? [],
    required:    f.required,
    isNHSValues: f.isNHSValues
  };
  const existing = (f.currentValue ?? f.value ?? '').trim();
  if (existing) entry.existingContent = existing;
  return entry;
}

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Sends SCAN_FORM to the content script on the active tab.
 * Returns { sessionExpired, fields, url, title } or throws.
 *
 * @param {number} tabId
 * @param {{tracMode?: boolean}} [opts] - tracMode expands TRAC's collapsed
 *   sections before scanning (only honoured by the content script on TRAC domains).
 */
export async function scanCurrentForm(tabId, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'SCAN_FORM', tracMode: !!opts.tracMode }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(
          'Could not connect to the page. Make sure you are on a supported job site ' +
          'and the page has fully loaded, then try again.'
        ));
        return;
      }
      resolve(response);
    });
  });
}

// ── Answer generation ─────────────────────────────────────────────────────────

/**
 * Calls Claude to generate suggested answers for the given form fields.
 * Pulls personal details and CV automatically.
 * Applies session corrections from previous fills.
 *
 * @param {Array}       fields       - from scanCurrentForm().fields
 * @param {AbortSignal} [signal]
 * @param {string}      [format]     - 'auto' | 'star' | 'narrative'
 * @param {object}      [jobContext] - the confirmed job { title, company, descriptionText } or null
 * @returns {Promise<Array<{fieldId,fieldName,fieldType,label,value,isDeclaration,existingValue,suggestion,review,...}>>}
 *   Each entry is the original field object + a `value` (default answer), plus `existingValue`,
 *   `suggestion`, and `review` ({verdict, reason}) for fields that arrived with pre-filled content.
 */
export async function generateAnswers(fields, signal, format = 'auto', jobContext = null) {
  if (!fields?.length) throw new Error('No form fields found on this page.');

  const [cv, personal, corrections] = await Promise.all([
    getActiveCV(),
    getPersonalDetails(),
    getSessionCorrections()
  ]);

  if (!cv) throw new Error('No active CV set. Please upload and select a CV in Settings first.');

  // ── Separate fields that need Claude vs those we can fill directly ──────────

  const directFills = {};   // fieldKey → value (no Claude needed)
  const needsClaude = [];   // fields to send to Claude

  for (const f of fields) {
    const key = `${f.id}|${f.name}`;

    // Declaration checkboxes → null (business rule: user must read and check these personally; auto-fill is never permitted)
    if (f.isDeclaration) {
      directFills[key] = null;
      continue;
    }

    // Apply session correction if the user already corrected this field
    if (corrections[key] !== undefined) {
      directFills[key] = corrections[key];
      continue;
    }

    // Professional registration number → from personal details
    if (f.isRegistrationNumber) {
      directFills[key] = personal.professionalRegistration?.number ?? '';
      continue;
    }

    // Right to work / visa → from personal details
    if (f.isRightToWork) {
      const rtwLabel = personal.rightToWork?.status ?? '';
      const rtwVisa  = personal.rightToWork?.visaType ?? '';
      directFills[key] = rtwVisa ? `${rtwLabel} — ${rtwVisa}` : rtwLabel;
      continue;
    }

    // Diversity monitoring → from stored preferences or blank
    if (f.isDiversity) {
      if (personal.diversityPreferences?.preferNotToSay) {
        directFills[key] = 'Prefer not to say';
      } else {
        directFills[key] = getDiversityValue(f.label, personal.diversityPreferences);
      }
      continue;
    }

    // Referee fields → from personal details
    if (f.isReferee) {
      directFills[key] = buildRefereeText(f.label, personal);
      continue;
    }

    // All other fields → Claude
    needsClaude.push(f);
  }

  // Build a text summary of personal details to pass in the system prompt
  const personalSummary = buildPersonalSummary(personal);

  // ── Claude call for remaining fields ─────────────────────────────────────

  let claudeAnswers = {};
  let claudeReviews = {};
  let recommendedFormat = format === 'auto' ? 'star' : format;
  let formatReason      = '';

  if (needsClaude.length > 0) {
    const fieldList = needsClaude.map(f => toFieldPayload({ ...f, fieldKey: `${f.id}|${f.name}` }));

    const system = buildSystemBlocks([
      { text: FORM_FILL_INSTRUCTIONS, cache: true },
      { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true },
      { text: `PERSONAL DETAILS:\n${personalSummary}`, cache: true }
    ]);

    // Job context goes in the user message (not a cached system block) since it
    // changes per job — keeping the CV/instructions blocks cache-eligible.
    const userMsg = `${buildJobBlock(jobContext)}\n\nFORM FIELDS TO ANSWER:\n` +
      `${JSON.stringify(fieldList, null, 2)}\n\nFORMAT: ${format}\n\nReturn the JSON response now.`;

    const raw = await callClaude({
      model:     'sonnet',
      system,
      messages:  [{ role: 'user', content: userMsg }],
      maxTokens: 3000,
      signal
    });

    try {
      const parsed = parseJSON(raw);
      // Handle new wrapped shape { recommendedFormat, formatReason, answers, reviews }
      // and old flat shape { fieldKey: answer } for backwards compatibility
      if (parsed && typeof parsed.answers === 'object' && !Array.isArray(parsed.answers)) {
        claudeAnswers = parsed.answers;
        claudeReviews = parsed.reviews ?? {};
        recommendedFormat = parsed.recommendedFormat ?? recommendedFormat;
        formatReason      = parsed.formatReason      ?? '';
      } else {
        claudeAnswers = parsed;
      }
    } catch (_) {
      console.warn('[form_filler] Could not parse Claude response as JSON');
    }
  }

  // ── Merge and return annotated fields ────────────────────────────────────

  const annotated = fields.map(f => {
    const key = `${f.id}|${f.name}`;

    // Personal-detail / declaration fields are filled directly — no review needed
    if (directFills.hasOwnProperty(key)) {
      return { ...f, value: directFills[key], fieldKey: key, existingValue: '', suggestion: null, review: null };
    }

    const existingValue = (f.currentValue || '').trim();
    const suggestion    = claudeAnswers[key] ?? '';
    // A review only applies when the field arrived with pre-filled content
    const review        = existingValue ? (claudeReviews[key] ?? null) : null;
    // Default selection = the recommendation: improved text if Claude says "improve",
    // otherwise the untouched existing text (never silently overwrite valuable content).
    const value = (existingValue && review)
      ? (review.verdict === 'improve' ? suggestion : existingValue)
      : suggestion;

    return { ...f, value, fieldKey: key, existingValue, suggestion, review };
  });

  // Recommendation is attached directly to the array object (not an element) so
  // JSON.stringify silently drops it during session cache — intentional, since the
  // recommendation is only relevant for the current popup open, not for restoration.
  annotated.recommendation = { format: recommendedFormat, reason: formatReason };

  return annotated;
}

/**
 * Re-runs analysis for a single field (used by the per-field "Re-analyse" button).
 * Re-assesses the field's current text against the CV and confirmed job.
 *
 * @param {object}      field        - annotated field; its current `.value` is treated as the existing text
 * @param {object}      [jobContext] - the confirmed job or null
 * @param {AbortSignal} [signal]
 * @param {string}      [format]
 * @returns {Promise<{suggestion:string, review:{verdict,reason}|null}>}
 */
export async function reanalyseField(field, jobContext, signal, format = 'auto') {
  const cv = await getActiveCV();
  if (!cv) throw new Error('No active CV set.');
  const personal        = await getPersonalDetails();
  const personalSummary = buildPersonalSummary(personal);

  const entry = toFieldPayload(field);

  const system = buildSystemBlocks([
    { text: FORM_FILL_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true },
    { text: `PERSONAL DETAILS:\n${personalSummary}`, cache: true }
  ]);

  const userMsg = `${buildJobBlock(jobContext)}\n\nFORM FIELDS TO ANSWER:\n` +
    `${JSON.stringify([entry], null, 2)}\n\nFORMAT: ${format}\n\nReturn the JSON response now.`;

  const raw = await callClaude({
    model:     'sonnet',
    system,
    messages:  [{ role: 'user', content: userMsg }],
    maxTokens: 1500,
    signal
  });

  const parsed  = parseJSON(raw);
  const answers = (parsed && typeof parsed.answers === 'object') ? parsed.answers : parsed;
  const reviews = parsed?.reviews ?? {};
  return {
    suggestion: answers?.[entry.key] ?? '',
    review:     reviews[entry.key]   ?? null
  };
}

// ── Fill ──────────────────────────────────────────────────────────────────────

/**
 * Sends approved answers to fill_form.js content script.
 *
 * @param {number} tabId
 * @param {Array}  annotatedFields - from generateAnswers(), after user review
 * @returns {Promise<object>} - map of fieldKey → 'filled'|'skipped_declaration'|'not_found'|'failed'
 */
export async function fillForm(tabId, annotatedFields) {
  // Only send fields that have a non-null value and aren't declarations
  const answers = annotatedFields
    .filter(f => f.value !== null && f.value !== undefined && f.value !== '')
    .map(f => ({
      fieldId:      f.id,
      fieldName:    f.name,
      fieldType:    f.type,
      value:        String(f.value),
      isDeclaration: f.isDeclaration
    }));

  if (!answers.length) throw new Error('No answers to inject — all fields were empty.');

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'FILL_FORM', answers }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error('Could not inject answers into the page. Please refresh and try again.'));
        return;
      }
      resolve(response?.results ?? {});
    });
  });
}

// ── Save a user correction to session memory ──────────────────────────────────

/**
 * Called when the user edits a suggested answer in the popup.
 * The corrected value is stored for the session so it isn't overwritten.
 */
export async function saveCorrection(fieldKey, correctedValue) {
  await saveSessionCorrection(fieldKey, correctedValue);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPersonalSummary(p) {
  const lines = [];
  if (p.fullLegalName) lines.push(`Name: ${p.fullLegalName}`);
  if (p.email)         lines.push(`Email: ${p.email}`);
  if (p.phone)         lines.push(`Phone: ${p.phone}`);
  if (p.address?.line1) {
    const addr = [p.address.line1, p.address.line2, p.address.city, p.address.postcode]
      .filter(Boolean).join(', ');
    lines.push(`Address: ${addr}`);
  }
  if (p.professionalRegistration?.type) {
    lines.push(`Professional Registration: ${p.professionalRegistration.type} ${p.professionalRegistration.number} (expires ${p.professionalRegistration.expiryDate || 'unknown'})`);
  }
  if (p.rightToWork?.status) {
    lines.push(`Right to Work: ${p.rightToWork.status}${p.rightToWork.visaType ? ` (${p.rightToWork.visaType})` : ''}`);
  }
  if (p.referee1?.name) {
    lines.push(`Referee 1: ${p.referee1.name}, ${p.referee1.jobTitle}, ${p.referee1.organisation} — ${p.referee1.email}`);
  }
  if (p.referee2?.name) {
    lines.push(`Referee 2: ${p.referee2.name}, ${p.referee2.jobTitle}, ${p.referee2.organisation} — ${p.referee2.email}`);
  }
  if (p.drivingLicence?.status) {
    lines.push(`Driving Licence: ${p.drivingLicence.status}${p.drivingLicence.categories ? ` (${p.drivingLicence.categories})` : ''}`);
  }
  return lines.join('\n') || 'No personal details stored yet.';
}

function getDiversityValue(label, prefs) {
  if (!prefs) return '';
  const l = label.toLowerCase();
  if (l.includes('gender') || l.includes(' sex '))     return prefs.gender || '';
  if (l.includes('ethnic'))                             return prefs.ethnicity || '';
  if (l.includes('disabilit'))                          return prefs.disability || '';
  if (l.includes('sexual orientation'))                 return prefs.sexualOrientation || '';
  if (l.includes('religion') || l.includes('belief'))  return prefs.religion || '';
  return '';
}

function buildRefereeText(label, personal) {
  const l  = label.toLowerCase();
  const r1 = personal.referee1;
  const r2 = personal.referee2;

  // Determine which referee slot
  const ref = (l.includes('2') || l.includes('second')) ? r2 : r1;
  if (!ref?.name) return '';

  if (l.includes('name'))         return ref.name;
  if (l.includes('email'))        return ref.email;
  if (l.includes('phone') || l.includes('tel')) return ref.phone;
  if (l.includes('job') || l.includes('title') || l.includes('position')) return ref.jobTitle;
  if (l.includes('organisation') || l.includes('employer') || l.includes('company')) return ref.organisation;
  if (l.includes('relationship')) return ref.relationship;

  // Generic referee field — return full block
  return [
    ref.name,
    ref.jobTitle,
    ref.organisation,
    ref.email,
    ref.phone,
    ref.relationship ? `Relationship: ${ref.relationship}` : ''
  ].filter(Boolean).join('\n');
}
