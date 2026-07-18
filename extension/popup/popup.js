/**
 * popup.js — UI Orchestrator
 *
 * Strict responsibility: All user interface — tab switching, routing button
 * clicks to the correct agent module, displaying results, error handling.
 * No business logic lives here. All computation is delegated to agents.
 */

// ── Agent imports ─────────────────────────────────────────────────────────────
import { getActiveCV, matchCV, optimiseCV, saveOptimisedCV,
         generateStatement, generateCoverLetter, getCVList, parseCV }
  from '../agents/cv_engine.js';

import { scanCurrentForm, generateAnswers, reanalyseField, fillForm as fillFormContent, saveCorrection }
  from '../agents/form_filler.js';

import { extractJobFromTab, analyseSponsorship, confirmEmployerSelection,
         checkManualEmployer, getSponsorshipChecklistStatus,
         verdictBadge, ensureRegister }
  from '../agents/sponsorship.js';

import { isKnownSite, getSiteType, suggestPattern }
  from '../agents/site_registry.js';

import { saveApplication, getApplications, updateApplication,
         deleteApplication, exportToExcel }
  from '../agents/job_tracker.js';

import { runAdvisor }
  from '../agents/advisor.js';

import { buildAlignmentBrief, getAlignmentBrief, deleteAlignmentBrief, chatRefineBrief, briefToContext }
  from '../agents/application_strategist.js';

import { ClaudeApiError }
  from '../utils/claude_api.js';

// ── Session state ─────────────────────────────────────────────────────────────
const state = {
  currentTab:          null,   // chrome tabs object
  jobData:             null,   // from extractJobFromTab
  matchResult:         null,   // from matchCV
  optimiseResult:      null,   // from optimiseCV
  docType:             'cover-letter',
  optimiseFormat:      'auto',
  fillFormat:          'auto',
  tracMode:            false,  // TRAC section-expanding scan (auto-ticked on trac.jobs)
  formFields:          null,   // from scanCurrentForm
  annotatedFields:     null,   // from generateAnswers
  fillJobContext:      null,   // confirmed job the form is being filled for
  _pendingJobs:        [],     // last-10 analysed jobs, staged for the context gate
  currentBrief:        null,   // alignment brief shown in the Strategist tab
  currentJobId:        null,   // id of the job analysed this session (links to its brief)
  sponsorshipVerdict:  null,
  applications:        [],
  sortField:           'applicationDeadline',
  sortDir:             'asc',
  stageFilter:         '',
  activeAbort:         null,   // AbortController
  savedAppId:          null,   // last saved application id
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }

function showSpinner(id) { show(id); }
function hideSpinner(id) { hide(id); }

function setDisabled(id, v) { const el = $(id); if (el) el.disabled = v; }

// True for any TRAC domain — both the advert site (www.trac.jobs) and the
// application site (apps.trac.jobs). Used to default the "TRAC form mode" toggle.
function isTracUrl(url) {
  try {
    return /(^|\.)trac\.jobs$/i.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

// ── Error handling ────────────────────────────────────────────────────────────

function showError(msgId, btnId, message, retryFn) {
  $(msgId).textContent = message;
  show(msgId.replace('-msg', ''));
  if (retryFn && btnId) {
    show(btnId);
    $(btnId).onclick = () => { clearError(msgId); retryFn(); };
  }
}

function clearError(msgId) {
  const box = $(msgId.replace('-msg', ''));
  if (box) box.classList.add('hidden');
}

function extractErrorMessage(err) {
  if (err instanceof ClaudeApiError) return err.message;
  return err?.message || 'An unexpected error occurred. Please try again.';
}

// ── AbortController management ────────────────────────────────────────────────

function newAbort() {
  state.activeAbort?.abort();
  state.activeAbort = new AbortController();
  return state.activeAbort.signal;
}

// ── Session persistence ───────────────────────────────────────────────────────

const SESSION_KEY          = 'jm_sessionCache';
const AUTO_RESTORE_MINS    = 10;
const SESSION_CACHE_MAX    = 10;   // per-URL analysis entries kept (LRU by timestamp)

/**
 * Reads the session cache as a { url: entry } map, migrating the old single-entry
 * format transparently so upgrades don't lose the last cached analysis.
 */
async function getSessionCacheMap() {
  const r   = await chrome.storage.local.get(SESSION_KEY).catch(() => ({}));
  const val = r[SESSION_KEY];
  if (!val || typeof val !== 'object') return {};
  // Old format was a single entry with top-level url/ts — wrap it into a map
  if (typeof val.url === 'string' && typeof val.ts === 'number') return { [val.url]: val };
  return val;
}
const ANALYSED_JOBS_KEY    = 'jm_analysedJobs';
const ANALYSED_JOBS_MAX    = 10;

/**
 * Adds an analysed advert to the front of the rolling last-10 history (de-duplicated).
 * Re-analysing the same advert REUSES its existing id, so any alignment brief built for
 * that job stays linked. Returns the job id.
 */
async function recordAnalysedJob(jobData) {
  if (!jobData || !(jobData.title || jobData.company)) return null;
  const entry = {
    id:              crypto.randomUUID(),
    title:           jobData.title || '',
    company:         jobData.company || '',
    descriptionText: jobData.descriptionText || '',
    url:             jobData.url || state.currentTab?.url || '',
    ts:              Date.now()
  };
  const r    = await chrome.storage.local.get(ANALYSED_JOBS_KEY).catch(() => ({}));
  let   list = r[ANALYSED_JOBS_KEY] ?? [];
  // Reuse the id of any prior record of the same advert so linked briefs survive
  const prior = list.find(j => j.title === entry.title && j.company === entry.company && j.url === entry.url);
  if (prior) entry.id = prior.id;
  list = list.filter(j => !(j.title === entry.title && j.company === entry.company && j.url === entry.url));
  list.unshift(entry);
  list = list.slice(0, ANALYSED_JOBS_MAX);
  await chrome.storage.local.set({ [ANALYSED_JOBS_KEY]: list });
  return entry.id;
}

/** Resolves the id of the current job — from this session, or by matching the analysed history. */
async function resolveCurrentJobId() {
  if (state.currentJobId) return state.currentJobId;
  const jd = state.jobData;
  if (!jd) return null;
  const jobs  = await getAnalysedJobs();
  const match = jobs.find(j => j.title === (jd.title || '') && j.company === (jd.company || ''));
  return match?.id ?? null;
}

/** @returns {Promise<Array>} the rolling last-10 analysed jobs, newest first. */
async function getAnalysedJobs() {
  const r = await chrome.storage.local.get(ANALYSED_JOBS_KEY).catch(() => ({}));
  return r[ANALYSED_JOBS_KEY] ?? [];
}

/**
 * Persists the current analysis state keyed by the active page URL. One entry is kept
 * per job page (up to SESSION_CACHE_MAX, LRU by timestamp), so switching between several
 * open job tabs retains each job's result. Saves whenever any meaningful result exists so
 * Sponsorship-only sessions are also captured (not just CV match sessions).
 */
async function saveSessionCache() {
  if (!state.currentTab?.url) return;
  if (!state.matchResult && !state.sponsorshipVerdict && !state.annotatedFields) return;
  const url   = state.currentTab.url;
  const entry = {
    url,
    ts:                 Date.now(),
    jobData:            state.jobData,
    matchResult:        state.matchResult,
    optimiseResult:     state.optimiseResult ?? null,
    docType:            state.docType,
    docText:            $('doc-output')?.value ?? '',
    advisorSuggestions: state._lastAdvisorSuggestions ?? null,
    sponsorshipVerdict: state.sponsorshipVerdict ?? null,
    formFields:         state.formFields ?? null,
    annotatedFields:    state.annotatedFields ?? null
  };

  const map = await getSessionCacheMap();
  map[url] = entry;

  // LRU eviction — drop the oldest entries once over the cap
  const urls = Object.keys(map);
  if (urls.length > SESSION_CACHE_MAX) {
    urls.sort((a, b) => (map[a].ts ?? 0) - (map[b].ts ?? 0)); // oldest first
    for (const u of urls.slice(0, urls.length - SESSION_CACHE_MAX)) delete map[u];
  }

  await chrome.storage.local.set({ [SESSION_KEY]: map });
}

/** On popup open: restore the cached analysis for the current URL, if any. */
async function checkAndRestoreSession() {
  const map   = await getSessionCacheMap();
  const cache = map[state.currentTab?.url];
  if (!cache) return;

  // Restore if we have at least one meaningful result
  const hasData = cache.matchResult || cache.sponsorshipVerdict || cache.annotatedFields;
  if (!hasData) return;

  const ageMins = (Date.now() - cache.ts) / 60_000;
  if (ageMins <= AUTO_RESTORE_MINS) {
    applySessionCache(cache, true); // auto-restore silently if session is fresh
  } else {
    showRestoreBanner(cache, ageMins); // offer opt-in restore for older sessions
  }
}

function applySessionCache(cache, silent = false) {
  if (cache.jobData)      state.jobData             = cache.jobData;
  if (cache.optimiseResult) state.optimiseResult    = cache.optimiseResult;
  if (cache.sponsorshipVerdict) state.sponsorshipVerdict = cache.sponsorshipVerdict;
  if (cache.formFields)   state.formFields           = cache.formFields;
  if (cache.annotatedFields) state.annotatedFields  = cache.annotatedFields;
  state.docType = cache.docType ?? 'cover-letter';

  if (cache.matchResult) {
    state.matchResult = cache.matchResult;
    renderMatchResult(cache.matchResult);
    show('results-job-analysis');
    hide('save-prompt'); // already saved or dismissed in the prior session
  } else if (cache.sponsorshipVerdict && !cache.matchResult) {
    // Sponsorship-only session — switch to Sponsorship tab automatically
    switchTab('sponsorship');
  }

  if (cache.docText) {
    $('doc-output').value = cache.docText;
    show('doc-output');
    show('doc-save-row');
  }

  if (cache.advisorSuggestions?.length) {
    show('advisor-section');
    renderAdvisorSuggestions(cache.advisorSuggestions);
  }

  if (cache.sponsorshipVerdict) {
    renderSponsorshipVerdict(cache.sponsorshipVerdict);
    show('sponsorship-results');
  }

  if (cache.annotatedFields?.length) {
    renderFormFields(cache.annotatedFields);
    show('fields-wrap');
  }

  if (!silent) {
    // Remove the restore banner after applying
    document.getElementById('restore-banner')?.remove();
  }
}

function showRestoreBanner(cache, ageMins) {
  const mins    = Math.round(ageMins);
  const banner  = document.createElement('div');
  banner.id     = 'restore-banner';
  banner.className = 'restore-banner';
  banner.innerHTML =
    `<span>Previous analysis found</span>` +
    `<span class="restore-age">${mins} min ago</span>` +
    `<button class="btn-secondary btn-sm" id="btn-restore-yes">Restore</button>` +
    `<button class="btn-ghost btn-sm"     id="btn-restore-no">Dismiss</button>`;

  // Insert between tabs and tab panels
  document.querySelector('.tab-panels').insertAdjacentElement('beforebegin', banner);

  document.getElementById('btn-restore-yes').addEventListener('click', () => {
    applySessionCache(cache, false);
  });
  document.getElementById('btn-restore-no').addEventListener('click', async () => {
    banner.remove();
    // Drop only this URL's entry — keep every other job's cached analysis
    const map = await getSessionCacheMap();
    delete map[state.currentTab?.url];
    await chrome.storage.local.set({ [SESSION_KEY]: map });
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabId) {
  $$('.tab-btn').forEach(b => {
    const active = b.dataset.tab === tabId;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $$('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tabId}`);
  });
  if (tabId === 'tracker')    renderTrackerTab();
  if (tabId === 'strategist') renderStrategistTab();
}

// ── Popup initialisation ──────────────────────────────────────────────────────

async function init() {
  // Bind tab buttons
  $$('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Settings
  $('open-settings').addEventListener('click', openSettings);

  // Get the active browser tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.currentTab = tab;
  } catch (_) {
    state.currentTab = null;
  }

  // Active CV display
  await refreshCVBar();

  // Site detection → show unknown banner or auto-switch tab
  if (state.currentTab?.url) {
    try {
      const known    = await isKnownSite(state.currentTab.url);
      const siteType = known ? await getSiteType(state.currentTab.url) : null;

      if (!known) {
        show('unknown-banner');
        $('btn-add-site').addEventListener('click', () => {
          openSettings('sites', suggestPattern(state.currentTab.url));
        });
      } else if (siteType === 'form') {
        switchTab('form-fill');
      }
      // Default: stays on Job Analysis tab
    } catch (_) {}
  }

  // Restore previous session (if same URL, < 10 min → auto; else → banner)
  await checkAndRestoreSession();

  // Wire all buttons
  wireJobAnalysis();
  wireFormFill();
  wireStrategist();
  wireSponsorship();
  wireTracker();
  wireCVBar();
}

// ── CV bar ────────────────────────────────────────────────────────────────────

async function refreshCVBar() {
  try {
    const cv = await getActiveCV();
    $('active-cv-name').textContent = cv?.label ?? 'None — add one in Settings';
  } catch (_) {}
}

function wireCVBar() {
  $('btn-change-cv').addEventListener('click', () => openSettings('cv'));
}

// ── ════════════════════════════════════════════════════════════════════════════
//    JOB ANALYSIS TAB
// ═════════════════════════════════════════════════════════════════════════════

function wireJobAnalysis() {
  $('btn-analyse').addEventListener('click', analyseJob);
  $('btn-optimise').addEventListener('click', optimiseCVHandler);
  $('btn-save-optimised').addEventListener('click', saveOptimisedHandler);
  $('btn-discard-optimised').addEventListener('click', discardOptimised);
  $('btn-save-app').addEventListener('click', saveAppToTracker);
  $('btn-dismiss-save').addEventListener('click', () => hide('save-prompt'));
  $('btn-generate-doc').addEventListener('click', generateDocHandler);
  $('btn-cancel-doc').addEventListener('click', cancelCurrentOp);
  $('btn-save-doc').addEventListener('click', saveDocHandler);

  $$('.doc-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.doc-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.docType = btn.dataset.doc;
      $('doc-section-label').textContent =
        state.docType === 'cover-letter' ? 'Cover Letter' : 'Supporting Statement';
    });
  });

  $$('#optimise-format-pills .format-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#optimise-format-pills .format-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.optimiseFormat = btn.dataset.format;
    });
  });
}

/** Parses uploaded job-document files (PDF/DOCX/TXT) into one text block; '' if none. */
async function parseJobDocs(fileList) {
  const files = Array.from(fileList ?? []);
  if (!files.length) return '';
  const texts = [];
  for (const f of files) {
    try {
      const t = await parseCV(f);
      if (t) texts.push(`=== ${f.name} ===\n${t}`);
    } catch (err) {
      console.warn('[job-docs] could not parse', f.name, err?.message);
    }
  }
  const combined = texts.join('\n\n');
  const status = $('jobdoc-status');
  if (status) {
    status.textContent = combined
      ? `✓ ${files.length} document${files.length > 1 ? 's' : ''} included (${combined.length.toLocaleString()} chars)`
      : 'Could not read the uploaded document(s).';
    status.classList.remove('hidden');
  }
  return combined;
}

async function analyseJob() {
  clearError('error-analyse-msg');
  hide('results-job-analysis');
  hide('save-prompt');

  const signal = newAbort();
  showSpinner('spinner-analyse');
  setDisabled('btn-analyse', true);

  try {
    // 1. Extract job data from the page
    let jobData = null;
    if (state.currentTab?.id) {
      try {
        jobData = await extractJobFromTab(state.currentTab.id);
        state.jobData = jobData;
      } catch (_) {
        // Continue without job data — user may be on a non-job page
      }
    }

    // 1b. Fold in any uploaded job documents (for adverts that just refer to attachments,
    //     or pages with little detail). Their text is merged into the job description so
    //     matching, optimise, document generation, and the recorded job all use it.
    const docsText = await parseJobDocs($('job-docs').files);
    if (docsText) {
      if (!jobData) jobData = { title: '', company: '', descriptionText: '' };
      jobData.descriptionText = [jobData.descriptionText, docsText].filter(Boolean).join('\n\n');
      state.jobData = jobData;
    }

    // 2. Match CV
    const jobText = [
      jobData?.title, jobData?.company,
      jobData?.descriptionText
    ].filter(Boolean).join('\n\n');

    if (!jobText) {
      throw new Error(
        'No job description found. Navigate to a specific job listing, or upload the ' +
        'job documents below (e.g. when the advert refers to attached documents).'
      );
    }

    state.matchResult = await matchCV(jobText, signal);
    renderMatchResult(state.matchResult);
    show('results-job-analysis');
    show('save-prompt');
    saveSessionCache(); // early save — captures score even if advisor is still running

    // Record this advert in the rolling history so Form Fill can offer it later.
    // Advert and application pages are usually on different sites, so we remember
    // the job rather than trying to re-detect it from the application page.
    state.currentJobId = await recordAnalysedJob(jobData);

    // Run advisor in the background so the match score appears immediately
    show('advisor-section');
    show('spinner-advisor');
    // Gap objects from cv_engine carry { requirement, reason }; flatten to strings for the advisor prompt
    const gapStrings = (state.matchResult?.gaps ?? [])
      .map(g => typeof g === 'string' ? g : `${g.requirement}: ${g.reason}`);
    runAdvisor(jobText, gapStrings, signal)
      .then(suggestions => {
        hideSpinner('spinner-advisor');
        state._lastAdvisorSuggestions = suggestions;
        renderAdvisorSuggestions(suggestions);
        saveSessionCache(); // persist with advisor suggestions included
      })
      .catch(err => {
        hideSpinner('spinner-advisor');
        if (err.name !== 'AbortError') {
          $('advisor-content').textContent = 'Could not load advisor suggestions.';
        }
      });

  } catch (err) {
    if (err.name === 'AbortError') return;
    showError('error-analyse-msg', 'retry-analyse', extractErrorMessage(err), analyseJob);
  } finally {
    hideSpinner('spinner-analyse');
    setDisabled('btn-analyse', false);
  }
}

function renderMatchResult(result) {
  const { score, fullMatches, partialMatches, gaps } = result;

  // Score display
  const scoreEl = $('match-score');
  scoreEl.textContent = `${score}%`;
  scoreEl.className = 'score-number ' +
    (score >= 80 ? 'score-high' : score >= 50 ? 'score-mid' : 'score-low');
  $('score-bar').style.width = `${score}%`;
  $('score-bar').style.background =
    score >= 80 ? 'var(--nhs-green)' : score >= 50 ? 'var(--nhs-orange)' : 'var(--nhs-red)';
  $('score-counts').textContent =
    `${fullMatches.length} full · ${partialMatches.length} partial · ${gaps.length} gaps`;

  // Tiers
  const tiersEl = $('match-tiers');
  tiersEl.innerHTML = '';
  tiersEl.append(
    makeTierSection('FULL MATCH',    'full',    fullMatches,    m => ({ req: m.requirement, evid: m.evidence })),
    makeTierSection('PARTIAL MATCH', 'partial', partialMatches, m => ({ req: m.requirement, evid: `${m.partialEvidence} — Gap: ${m.gap}` })),
    makeTierSection('GAP',           'gap',     gaps,           m => ({ req: m.requirement, evid: m.reason }))
  );
}

function makeTierSection(label, cls, items, mapper) {
  const section = document.createElement('div');
  section.className = 'tier-section';
  if (!items.length) return section;

  const hd = document.createElement('div');
  hd.className = `tier-header ${cls}`;
  hd.innerHTML = `<span>[${label}]</span><span class="tier-badge">${items.length}</span>`;
  hd.addEventListener('click', () => body.classList.toggle('hidden'));
  section.appendChild(hd);

  const body = document.createElement('div');
  body.className = 'tier-items';
  for (const item of items) {
    const { req, evid } = mapper(item);
    const div = document.createElement('div');
    div.className = 'tier-item';
    div.innerHTML = `<div class="req">${escHtml(req)}</div><div class="evid">${escHtml(evid)}</div>`;
    body.appendChild(div);
  }
  section.appendChild(body);
  return section;
}

async function optimiseCVHandler() {
  const jobText = getJobText();
  if (!jobText) { alert('Please analyse a job first.'); return; }

  clearError('error-optimise-msg');
  show('optimise-body');
  showSpinner('spinner-optimise');
  hide('diff-view');
  hide('optimise-actions');
  setDisabled('btn-optimise', true);

  const signal = newAbort();
  try {
    state.optimiseResult = await optimiseCV(jobText, signal, state.optimiseFormat);
    renderDiff(state.optimiseResult);
    show('diff-view');
    show('optimise-actions');
  } catch (err) {
    if (err.name !== 'AbortError')
      showError('error-optimise-msg', 'retry-optimise', extractErrorMessage(err), optimiseCVHandler);
  } finally {
    hideSpinner('spinner-optimise');
    setDisabled('btn-optimise', false);
  }
}

function renderDiff(result) {
  // Show format recommendation badge
  const recEl = $('optimise-format-rec');
  if (recEl && result.formatReason) {
    const label = result.recommendedFormat === 'star' ? 'STAR' : 'Standard';
    recEl.textContent = `${label} format recommended — ${result.formatReason}`;
    recEl.classList.remove('hidden');
  }

  const diffEl = $('diff-view');
  diffEl.innerHTML = '';

  if (!result.changes?.length) {
    diffEl.textContent = 'No specific changes were generated.';
    return;
  }

  for (const change of result.changes) {
    const row = document.createElement('div');
    row.className = 'diff-change';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.changeIdx = result.changes.indexOf(change);
    cb.setAttribute('aria-label', `Approve change: ${change.type}`);

    const badge = document.createElement('span');
    badge.className = `diff-type ${change.type}`;
    badge.textContent = change.type.toUpperCase();

    const text = document.createElement('div');
    text.className = 'diff-text';
    text.innerHTML = `<del>${escHtml(change.original)}</del> → <ins>${escHtml(change.changed)}</ins>` +
                     `<div class="diff-reason">${escHtml(change.reason)}</div>`;

    row.append(cb, badge, text);
    diffEl.appendChild(row);
  }

  if (result.unfillableGaps?.length) {
    const note = document.createElement('div');
    note.className = 'info-box mt-8';
    note.innerHTML = `<strong>Genuine gaps (cannot fill from CV):</strong><ul style="margin-left:16px;margin-top:4px;">` +
      result.unfillableGaps.map(g => `<li>${escHtml(g)}</li>`).join('') + '</ul>';
    diffEl.appendChild(note);
  }
}

async function saveOptimisedHandler() {
  if (!state.optimiseResult) return;
  const jobTitle = state.jobData?.title || 'Optimised';

  // Collect only approved changes (ticked checkboxes)
  const approvedIndices = new Set(
    [...$$('#diff-view input[type="checkbox"]:checked')]
      .map(cb => parseInt(cb.dataset.changeIdx, 10))
  );

  // For simplicity, save the full optimised text
  // (a more granular approach would reconstruct the CV with only approved changes)
  try {
    await saveOptimisedCV(state.optimiseResult.optimisedText, jobTitle);
    hide('optimise-actions');
    $('diff-view').insertAdjacentHTML('afterend',
      '<div class="info-box mt-8">✓ Optimised CV saved. Original preserved.</div>');
  } catch (err) {
    alert(extractErrorMessage(err));
  }
}

function discardOptimised() {
  state.optimiseResult = null;
  hide('optimise-body');
}

async function generateDocHandler() {
  const jobText = getJobText();
  if (!jobText) { alert('Please analyse a job first.'); return; }

  const type = state.docType;
  const output = $('doc-output');
  output.value = '';
  show('doc-output');
  showSpinner('spinner-doc');
  show('btn-cancel-doc');
  hide('doc-save-row');
  setDisabled('btn-generate-doc', true);

  // Use this job's alignment brief, if one exists, to tailor the document to the
  // selection criteria and any confirmed extra experience (optional).
  const briefJobId   = await resolveCurrentJobId();
  const brief        = briefJobId ? await getAlignmentBrief(briefJobId) : null;
  const briefContext = briefToContext(brief);

  const signal = newAbort();
  try {
    const opts = {
      signal,
      briefContext,
      onChunk: chunk => { output.value += chunk; output.scrollTop = output.scrollHeight; }
    };
    if (type === 'cover-letter') {
      await generateCoverLetter(jobText, opts);
    } else {
      await generateStatement(jobText, opts);
    }
    show('doc-save-row');
    saveSessionCache(); // persist generated document text
  } catch (err) {
    if (err.name !== 'AbortError') alert(extractErrorMessage(err));
  } finally {
    hideSpinner('spinner-doc');
    hide('btn-cancel-doc');
    setDisabled('btn-generate-doc', false);
  }
}

async function saveDocHandler() {
  const text = $('doc-output').value.trim();
  if (!text) return;
  const label = `${state.docType === 'cover-letter' ? 'Cover Letter' : 'Statement'} — ${state.jobData?.title || 'Unnamed'}`;
  // Store generated document text alongside the application
  chrome.storage.local.get('savedDocs', r => {
    const docs = r.savedDocs || [];
    docs.push({ id: crypto.randomUUID(), label, text, date: new Date().toISOString() });
    chrome.storage.local.set({ savedDocs: docs });
  });
  $('btn-save-doc').textContent = '✓ Saved';
  setTimeout(() => { $('btn-save-doc').textContent = 'Save document'; }, 2000);
}

async function saveAppToTracker() {
  try {
    const matchScore = state.matchResult?.score ?? null;
    const id = await saveApplication({
      jobTitle:            state.jobData?.title     || 'Unknown',
      companyName:         state.jobData?.company   || 'Unknown',
      jobSiteUrl:          state.jobData?.url       || state.currentTab?.url || '',
      matchScore,
      sponsorshipVerdict:  state.sponsorshipVerdict ?? null,
      applicationDeadline: state.jobData?.closingDate || '',
      stage:               'Applied'
    });
    state.savedAppId = id;
    hide('save-prompt');
    const conf = document.createElement('div');
    conf.className = 'info-box mt-8';
    conf.textContent = '✓ Saved to tracker.';
    $('save-prompt').insertAdjacentElement('afterend', conf);
    setTimeout(() => conf.remove(), 3000);
  } catch (err) {
    alert(extractErrorMessage(err));
  }
}

function renderAdvisorSuggestions(suggestions) {
  const content = $('advisor-content');
  content.innerHTML = '';

  if (!suggestions?.length) {
    content.textContent = 'No specific suggestions at this time.';
    return;
  }

  $('advisor-count').textContent = `(${suggestions.length})`;

  for (const s of suggestions) {
    const item = document.createElement('div');
    item.className = 'suggestion-item';

    const badge = document.createElement('span');
    badge.className = `priority-badge ${(s.priority || 'medium').toLowerCase()}`;
    badge.textContent = (s.priority || 'Medium').charAt(0).toUpperCase() + (s.priority || 'medium').slice(1);

    const text = document.createElement('span');
    text.className = 'suggestion-text';
    text.textContent = s.text || s;

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-ghost btn-sm';
    addBtn.textContent = 'Add goal';
    addBtn.addEventListener('click', async () => {
      try {
        await chrome.storage.local.get('goals', r => {
          const goals = r.goals || [];
          goals.push({ id: crypto.randomUUID(), text: s.text || s, source: state.jobData?.title || '', dateAdded: new Date().toISOString(), status: 'active' });
          chrome.storage.local.set({ goals });
        });
        addBtn.textContent = '✓ Saved';
        addBtn.disabled = true;
      } catch (_) {}
    });

    item.append(badge, text, addBtn);
    content.appendChild(item);
  }
}

// ── ════════════════════════════════════════════════════════════════════════════
//    FORM FILL TAB
// ═════════════════════════════════════════════════════════════════════════════

function wireFormFill() {
  $('btn-scan-form').addEventListener('click', scanFormHandler);
  $('btn-fill-form').addEventListener('click', fillFormHandler);

  $$('#fill-format-pills .format-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#fill-format-pills .format-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.fillFormat = btn.dataset.format;
    });
  });

  // Job-context gate buttons
  $('jcg-confirm').addEventListener('click', () => proceedWithAnswers(state._pendingJobs[0] ?? null));
  $('jcg-pick').addEventListener('click', () => {
    hide('jcg-actions');
    show('jcg-picker');
  });
  $('jcg-picker-confirm').addEventListener('click', () => {
    const id  = $('jcg-select').value;
    const job = state._pendingJobs.find(j => j.id === id) ?? null;
    proceedWithAnswers(job);
  });
  $('jcg-cvonly').addEventListener('click', () => proceedWithAnswers(null));

  // TRAC form mode: default it ON when the active tab is a TRAC domain, but
  // leave the user free to override — this only sets the initial checkbox state.
  const tracToggle = $('trac-mode');
  if (tracToggle) {
    state.tracMode  = isTracUrl(state.currentTab?.url);
    tracToggle.checked = state.tracMode;
    tracToggle.addEventListener('change', () => { state.tracMode = tracToggle.checked; });
  }
}

async function scanFormHandler() {
  if (!state.currentTab?.id) { showError('error-form-msg', null, 'No active tab found.', null); return; }

  clearError('error-form-msg');
  hide('fields-wrap');
  hide('job-context-gate');
  hide('fill-format-rec');
  showSpinner('spinner-scan');
  setDisabled('btn-scan-form', true);
  hide('session-warning');

  const signal = newAbort();
  try {
    const scanResult = await scanCurrentForm(state.currentTab.id, { tracMode: state.tracMode });

    if (scanResult.sessionExpired) {
      show('session-warning');
      return;
    }

    // Stop after scanning — the user must confirm which job before we generate answers
    state.formFields = scanResult.fields;
    await showJobContextGate();

  } catch (err) {
    if (err.name === 'AbortError') return;
    showError('error-form-msg', 'retry-scan', extractErrorMessage(err), scanFormHandler);
  } finally {
    hideSpinner('spinner-scan');
    setDisabled('btn-scan-form', false);
  }
}

/**
 * After a scan, asks the user to confirm which analysed job the form is for.
 * Always confirms (never silently matches) — near-identical jobs can only be told
 * apart by the user. Falls back to a CV-only path when nothing has been analysed.
 */
async function showJobContextGate() {
  const jobs = await getAnalysedJobs();
  state._pendingJobs = jobs;

  hide('jcg-picker');
  show('jcg-actions');

  if (!jobs.length) {
    // Nothing analysed yet — recommend analysing the advert, allow CV-only as a fallback
    $('jcg-question').textContent =
      'No analysed job adverts found. For tailored answers, open the job advert and click ' +
      '“Analyse this job” first, then scan again — or fill from your CV only.';
    hide('jcg-actions');
    populateJobSelect([]);
    show('jcg-picker');
    show('job-context-gate');
    return;
  }

  const top       = jobs[0];
  const hasBrief  = !!(await getAlignmentBrief(top.id));
  const briefNote = hasBrief ? ` <span class="jcg-brief">· ✓ alignment brief will be applied</span>` : '';
  $('jcg-question').innerHTML =
    `Applying for: <strong>${escHtml(top.company || 'Unknown')} — ${escHtml(top.title || 'Untitled role')}</strong> ` +
    `<span class="jcg-age">(analysed ${timeAgo(top.ts)})</span>${briefNote}<br>Is this the job you're filling this form for?`;
  populateJobSelect(jobs);
  show('job-context-gate');
}

/** Fills the "pick another" dropdown with the last-10 analysed jobs (timestamped to disambiguate). */
function populateJobSelect(jobs) {
  const sel = $('jcg-select');
  sel.innerHTML = '';
  if (!jobs.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No analysed jobs available';
    opt.disabled = true;
    sel.appendChild(opt);
    $('jcg-picker-confirm').disabled = true;
    return;
  }
  $('jcg-picker-confirm').disabled = false;
  for (const j of jobs) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `${j.company || 'Unknown'} — ${j.title || 'Untitled'} · ${timeAgo(j.ts)}`;
    sel.appendChild(opt);
  }
}

/** Generates answers for the confirmed job (or CV-only when jobContext is null), then renders. */
async function proceedWithAnswers(jobContext) {
  hide('job-context-gate');
  state.fillJobContext = jobContext;

  if (!state.formFields?.length) return;

  showSpinner('spinner-scan');
  setDisabled('btn-scan-form', true);

  // Pull in the alignment brief for this job, if one exists (optional — form fill
  // works identically without it).
  const brief        = jobContext ? await getAlignmentBrief(jobContext.id) : null;
  const briefContext = briefToContext(brief);

  const signal = newAbort();
  try {
    const answers = await generateAnswers(state.formFields, signal, state.fillFormat, jobContext, briefContext);
    state.annotatedFields = answers;

    // Show format recommendation badge
    if (answers.recommendation?.reason) {
      const rec   = answers.recommendation;
      const label = rec.format === 'star' ? 'STAR' : 'Narrative';
      const badge = $('fill-format-rec');
      badge.textContent = `${label} format recommended — ${rec.reason}`;
      badge.classList.remove('hidden');
    }

    renderActiveJob(jobContext, !!briefContext);
    renderFormFields(answers);
    show('fields-wrap');
    saveSessionCache(); // persist form fields + generated answers

  } catch (err) {
    if (err.name === 'AbortError') return;
    showError('error-form-msg', 'retry-scan', extractErrorMessage(err), () => proceedWithAnswers(jobContext));
  } finally {
    hideSpinner('spinner-scan');
    setDisabled('btn-scan-form', false);
  }
}

/** Shows a small banner above the fields naming the job the answers were tailored for. */
function renderActiveJob(jobContext, usedBrief = false) {
  const el = $('fill-active-job');
  if (jobContext && (jobContext.title || jobContext.company)) {
    const briefTag = usedBrief ? ` <span class="brief-tag">✓ alignment brief applied</span>` : '';
    el.innerHTML = `Answers tailored for: <strong>${escHtml(jobContext.company || 'Unknown')} — ` +
      `${escHtml(jobContext.title || 'Untitled role')}</strong>${briefTag}`;
    el.classList.remove('hidden');
  } else {
    el.textContent = 'Answers generated from your CV only (no specific job selected).';
    el.classList.remove('hidden');
  }
}

function renderFormFields(fields) {
  const list = $('fields-list');
  list.innerHTML = '';

  const countEl = $('fields-count');
  countEl.textContent = `${fields.length} field${fields.length !== 1 ? 's' : ''} detected`;

  for (const f of fields) {
    const item = document.createElement('div');
    item.className = `field-item${f.isDeclaration ? ' declaration' : ''}`;
    item.setAttribute('role', 'listitem');

    const label = document.createElement('div');
    label.className = 'field-label';
    label.innerHTML = `${escHtml(f.label || f.name || f.id)}
      <span class="field-type-badge">${f.type}</span>`;

    if (f.isDeclaration) {
      const warn = document.createElement('div');
      warn.className = 'declaration-warning';
      warn.textContent = '⚠ Declaration checkbox — please read and check this yourself. It will not be auto-filled.';
      item.append(label, warn);
    } else if (f.existingValue && f.review) {
      // Pre-filled field — show existing content, verdict, and a keep/improve choice
      renderReviewField(item, label, f);
    } else {
      const answer = document.createElement('textarea');
      answer.className = 'field-answer';
      answer.rows = f.type === 'textarea' ? 3 : 1;
      answer.value = f.value ?? '';
      answer.dataset.fieldKey = f.fieldKey;
      answer.placeholder = 'Suggested answer…';
      answer.setAttribute('aria-label', `Answer for: ${f.label || f.id}`);
      answer.addEventListener('change', () => syncFieldValue(f.fieldKey, answer.value));
      item.append(label, answer);
    }

    list.appendChild(item);
  }

  hide('fill-results');
}

/** Builds the pre-filled-content review UI: existing text, verdict, keep/improve toggle, re-analyse. */
function renderReviewField(item, label, f) {
  const isImprove = f.review.verdict === 'improve';

  const existLabel = document.createElement('div');
  existLabel.className = 'existing-label';
  existLabel.textContent = 'Already on the form:';

  const existBox = document.createElement('div');
  existBox.className = 'existing-content';
  existBox.textContent = f.existingValue;

  const verdict = document.createElement('div');
  verdict.className = `review-verdict ${isImprove ? 'improve' : 'keep'}`;
  verdict.textContent = `${isImprove ? '🟡 Could be improved' : '🟢 Looks good'}${f.review.reason ? ' — ' + f.review.reason : ''}`;

  const answer = document.createElement('textarea');
  answer.className = 'field-answer';
  answer.rows = 3;
  answer.value = f.value ?? '';        // default = the recommended option
  answer.dataset.fieldKey = f.fieldKey;
  answer.setAttribute('aria-label', `Answer for: ${f.label || f.id}`);
  answer.addEventListener('change', () => syncFieldValue(f.fieldKey, answer.value));

  // Keep / improve choice — defaults to the recommendation, swaps the textarea text
  const choice = document.createElement('div');
  choice.className = 'review-choice';
  const gname = `choice-${f.fieldKey}`;
  choice.innerHTML =
    `<label><input type="radio" name="${gname}" value="keep" ${isImprove ? '' : 'checked'}> Keep existing</label>` +
    `<label><input type="radio" name="${gname}" value="improve" ${isImprove ? 'checked' : ''}> Use improved</label>`;
  choice.querySelectorAll('input').forEach(radio => {
    radio.addEventListener('change', () => {
      answer.value = radio.value === 'improve' ? (f.suggestion ?? '') : (f.existingValue ?? '');
      syncFieldValue(f.fieldKey, answer.value);
    });
  });

  const reBtn = document.createElement('button');
  reBtn.className = 'btn-ghost btn-sm reanalyse-btn';
  reBtn.textContent = '↻ Re-analyse';
  reBtn.addEventListener('click', () => reanalyseFieldHandler(f, reBtn, answer, verdict));

  item.append(label, existLabel, existBox, verdict, choice, answer, reBtn);
}

/** Mirrors an edited answer back into state and session correction memory, keyed by fieldKey. */
function syncFieldValue(fieldKey, value) {
  const idx = state.annotatedFields?.findIndex(af => af.fieldKey === fieldKey);
  if (idx !== undefined && idx >= 0) state.annotatedFields[idx].value = value;
  saveCorrection(fieldKey, value);
}

/** Re-runs analysis for one field using its current text, then refreshes the verdict and suggestion. */
async function reanalyseFieldHandler(f, btn, answerEl, verdictEl) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  const signal = newAbort();
  try {
    // Treat whatever is currently in the textarea as the text to reassess
    // (currentValue is what toFieldPayload reads first, so it must reflect the edit)
    const fieldForRe = { ...f, currentValue: answerEl.value, value: answerEl.value, existingValue: answerEl.value };
    const { suggestion, review } = await reanalyseField(fieldForRe, state.fillJobContext, signal, state.fillFormat);

    const idx = state.annotatedFields?.findIndex(af => af.fieldKey === f.fieldKey);
    if (idx !== undefined && idx >= 0) {
      if (suggestion) state.annotatedFields[idx].suggestion = suggestion;
      if (review)     state.annotatedFields[idx].review     = review;
    }
    if (review) {
      const isImprove = review.verdict === 'improve';
      verdictEl.className = `review-verdict ${isImprove ? 'improve' : 'keep'}`;
      verdictEl.textContent = `${isImprove ? '🟡 Could be improved' : '🟢 Looks good'}${review.reason ? ' — ' + review.reason : ''}`;
    }
    if (suggestion) {
      answerEl.value = suggestion;
      syncFieldValue(f.fieldKey, suggestion);
    }
  } catch (err) {
    if (err.name !== 'AbortError') alert(extractErrorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function fillFormHandler() {
  if (!state.annotatedFields?.length) return;
  if (!state.currentTab?.id) return;

  showSpinner('spinner-fill');
  setDisabled('btn-fill-form', true);

  try {
    // Sync textarea edits back to annotatedFields by fieldKey (index-based is unsafe:
    // declaration fields render no textarea, so positions no longer line up 1:1).
    $$('#fields-list .field-answer').forEach(ta => {
      const idx = state.annotatedFields.findIndex(af => af.fieldKey === ta.dataset.fieldKey);
      if (idx >= 0) state.annotatedFields[idx].value = ta.value;
    });

    const results = await fillFormContent(state.currentTab.id, state.annotatedFields);
    renderFillResults(results);
  } catch (err) {
    showError('error-form-msg', null, extractErrorMessage(err), null);
  } finally {
    hideSpinner('spinner-fill');
    setDisabled('btn-fill-form', false);
  }
}

function renderFillResults(results) {
  const el = $('fill-results');
  el.innerHTML = '';
  show('fill-results');

  const filled  = Object.values(results).filter(v => v === 'filled').length;
  const skipped = Object.values(results).filter(v => v === 'skipped_declaration').length;
  const missing = Object.values(results).filter(v => v === 'not_found').length;

  el.innerHTML =
    `<span class="filled">✓ ${filled} filled</span>` +
    (skipped ? ` &nbsp; <span class="skipped">⚠ ${skipped} declaration${skipped > 1 ? 's' : ''} skipped (manual)</span>` : '') +
    (missing ? ` &nbsp; <span class="not-found">✗ ${missing} not found</span>` : '');
}

// ── ════════════════════════════════════════════════════════════════════════════
//    STRATEGIST TAB (Agent 10)
// ═════════════════════════════════════════════════════════════════════════════

function wireStrategist() {
  $('btn-build-brief').addEventListener('click', buildBriefHandler);
  $('btn-delete-brief').addEventListener('click', deleteBriefHandler);
  // Changing the selected job loads that job's existing brief (or clears the view)
  $('strat-job-select').addEventListener('change', loadBriefForSelectedJob);
  // Supporting statement built from the brief
  $('btn-strat-statement').addEventListener('click', stratStatementHandler);
  $('btn-strat-statement-save').addEventListener('click', stratStatementSaveHandler);
  $('btn-strat-statement-cancel').addEventListener('click', () => {
    state.activeAbort?.abort();
    hideSpinner('spinner-strat-statement');
    hide('btn-strat-statement-cancel');
    setDisabled('btn-strat-statement', false);
  });

  // Refinement chat
  $('btn-strat-chat-send').addEventListener('click', stratChatSendHandler);
  $('strat-chat-input').addEventListener('keydown', e => {
    // Enter sends; Shift+Enter inserts a newline
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); stratChatSendHandler(); }
  });
  // Persist the draft as the user types so it survives tab switches / popup close
  $('strat-chat-input').addEventListener('input', e => {
    queueSaveStratDraft(state.currentBrief?.jobId, e.target.value);
  });
}

// Draft persistence for the Strategist chat box (per job, in session storage so it
// survives popup close but not a browser restart).
const STRAT_DRAFT_KEY = 'jm_stratChatDrafts';
let _stratDraftTimer  = null;

async function getStratDraft(jobId) {
  if (!jobId) return '';
  try {
    const r = await chrome.storage.session.get(STRAT_DRAFT_KEY);
    return (r[STRAT_DRAFT_KEY] ?? {})[jobId] ?? '';
  } catch (_) { return ''; }
}

function queueSaveStratDraft(jobId, text) {
  if (!jobId) return;
  clearTimeout(_stratDraftTimer);
  _stratDraftTimer = setTimeout(async () => {
    try {
      const r   = await chrome.storage.session.get(STRAT_DRAFT_KEY);
      const map = r[STRAT_DRAFT_KEY] ?? {};
      if (text) map[jobId] = text; else delete map[jobId];
      await chrome.storage.session.set({ [STRAT_DRAFT_KEY]: map });
    } catch (_) {}
  }, 250);
}

async function clearStratDraft(jobId) {
  if (!jobId) return;
  try {
    const r   = await chrome.storage.session.get(STRAT_DRAFT_KEY);
    const map = r[STRAT_DRAFT_KEY] ?? {};
    delete map[jobId];
    await chrome.storage.session.set({ [STRAT_DRAFT_KEY]: map });
  } catch (_) {}
}

/** Populates the job dropdown from the last-10 analysed jobs and shows the selected job's brief. */
async function renderStrategistTab() {
  const jobs = await getAnalysedJobs();
  const sel  = $('strat-job-select');
  const prev = sel.value;

  sel.innerHTML = '';
  if (!jobs.length) {
    $('strat-no-jobs-hint').hidden = false;
    setDisabled('btn-build-brief', true);
    hide('strat-results');
    return;
  }
  $('strat-no-jobs-hint').hidden = true;
  setDisabled('btn-build-brief', false);

  for (const j of jobs) {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `${j.company || 'Unknown'} — ${j.title || 'Untitled'} · ${timeAgo(j.ts)}`;
    sel.appendChild(opt);
  }
  // Preserve the previous selection if it still exists
  if (prev && jobs.some(j => j.id === prev)) sel.value = prev;

  await loadBriefForSelectedJob();
}

/** Shows the stored brief for the currently selected job, or clears the results area. */
async function loadBriefForSelectedJob() {
  const jobId = $('strat-job-select').value;
  const brief = jobId ? await getAlignmentBrief(jobId) : null;
  state.currentBrief = brief;
  if (brief) {
    renderBrief(brief);
    $('strat-chat-input').value = await getStratDraft(jobId); // restore any unsent draft
  } else {
    hide('strat-results');
  }
}

async function buildBriefHandler() {
  const jobId = $('strat-job-select').value;
  if (!jobId) { showError('error-strat-msg', null, 'Select a job first.', null); return; }

  const jobFiles = $('strat-job-files').files;
  if (!jobFiles?.length) {
    showError('error-strat-msg', null, 'Upload at least one job document (JD or person specification).', null);
    return;
  }

  const job     = state._pendingJobs.find(j => j.id === jobId)
               ?? (await getAnalysedJobs()).find(j => j.id === jobId);
  const cvFile  = $('strat-cv-file').files?.[0] || null;
  const cvLabel = $('strat-cv-label').value.trim();

  clearError('error-strat-msg');
  hide('strat-results');
  showSpinner('spinner-strat');
  setDisabled('btn-build-brief', true);

  const signal = newAbort();
  try {
    const brief = await buildAlignmentBrief(jobId, jobFiles, {
      cvFile, cvLabel,
      includeAdditionalDetails: $('strat-include-additional').checked,
      jobTitle: job?.title || '',
      company:  job?.company || '',
      signal
    });
    state.currentBrief = brief;
    renderBrief(brief);
    await refreshCVBar(); // a tailored CV may have been saved as a new active-eligible version
  } catch (err) {
    if (err.name !== 'AbortError')
      showError('error-strat-msg', 'retry-strat', extractErrorMessage(err), buildBriefHandler);
  } finally {
    hideSpinner('spinner-strat');
    setDisabled('btn-build-brief', false);
  }
}

async function deleteBriefHandler() {
  if (!state.currentBrief) return;
  if (!confirm('Delete this alignment brief?')) return;
  await deleteAlignmentBrief(state.currentBrief.jobId);
  state.currentBrief = null;
  hide('strat-results');
}

function renderBrief(brief) {
  $('strat-brief-title').textContent =
    `${brief.company || 'Unknown'} — ${brief.jobTitle || 'Untitled role'}`;

  // Positioning
  const posEl = $('strat-positioning');
  posEl.textContent = brief.positioning || '';
  posEl.classList.toggle('hidden', !brief.positioning);

  // Keywords
  const kwEl = $('strat-keywords');
  kwEl.innerHTML = '';
  if (brief.keywords?.length) {
    for (const k of brief.keywords) {
      const chip = document.createElement('span');
      chip.className = 'strat-keyword';
      chip.textContent = k;
      kwEl.appendChild(chip);
    }
  }

  // Summary counts
  const met     = brief.criteria.filter(c => c.status === 'met').length;
  const partial = brief.criteria.filter(c => c.status === 'partial').length;
  const gap     = brief.criteria.filter(c => c.status === 'gap').length;
  $('strat-summary').innerHTML =
    `<span class="met">${met} met</span> · ` +
    `<span class="partial">${partial} partial</span> · ` +
    `<span class="gap">${gap} gap${gap !== 1 ? 's' : ''}</span> ` +
    `<span class="strat-cv-note">CV: ${escHtml(brief.cvLabel || '—')}</span>`;

  // Criteria list
  const critEl = $('strat-criteria');
  critEl.innerHTML = '';
  for (const c of brief.criteria) {
    const row = document.createElement('div');
    row.className = `strat-criterion ${c.status}`;
    const icon = c.status === 'met' ? '🟢' : c.status === 'partial' ? '🟡' : '🔴';
    row.innerHTML =
      `<div class="crit-hd">${icon} <span class="crit-level ${c.level}">${escHtml((c.level || '').toUpperCase())}</span> ` +
      `<span class="crit-cat">${escHtml(c.category || '')}</span></div>` +
      `<div class="crit-text">${escHtml(c.text || '')}</div>` +
      (c.evidence ? `<div class="crit-evidence"><strong>Your evidence:</strong> ${escHtml(c.evidence)}</div>` : '') +
      (c.talkingPoint ? `<div class="crit-talking"><strong>Suggested angle:</strong> ${escHtml(c.talkingPoint)}</div>` : '');
    critEl.appendChild(row);
  }

  // Genuine gaps callout — derived from criteria still marked "gap" so it updates
  // live as the refinement chat re-maps them.
  const gapsEl   = $('strat-gaps');
  const gapItems = brief.criteria.filter(c => c.status === 'gap').map(c => c.text);
  gapsEl.innerHTML = '';
  if (gapItems.length) {
    gapsEl.innerHTML =
      `<strong>Genuine gaps (not covered yet):</strong>` +
      `<ul>${gapItems.map(g => `<li>${escHtml(g)}</li>`).join('')}</ul>`;
    gapsEl.classList.remove('hidden');
  } else {
    gapsEl.classList.add('hidden');
  }

  // Clear the statement only when a *different* brief is shown — not on same-brief
  // re-renders (e.g. after a chat message), so a generated statement isn't lost.
  if (_statementBriefId !== brief.id) {
    resetStratStatement();
    _statementBriefId = brief.id;
  }
  renderChat(brief);
  show('strat-results');
}

let _statementBriefId = null;

/** Resets the supporting-statement area (called when a different brief is shown). */
function resetStratStatement() {
  const out = $('strat-statement-output');
  if (out) out.value = '';
  hide('strat-statement-output');
  hide('strat-statement-save-row');
  hide('btn-strat-statement-cancel');
  hideSpinner('spinner-strat-statement');
  setDisabled('btn-strat-statement', false);
}

/** Generates a supporting statement from the current brief (streamed). */
async function stratStatementHandler() {
  const brief = state.currentBrief;
  if (!brief) return;

  // Prefer the analysed job's full description; fall back to the brief's own content
  const jobs    = await getAnalysedJobs();
  const job     = jobs.find(j => j.id === brief.jobId);
  const jobText = job?.descriptionText
    || [brief.company, brief.jobTitle, ...brief.criteria.map(c => c.text)].filter(Boolean).join('\n');

  const output = $('strat-statement-output');
  output.value = '';
  show('strat-statement-output');
  showSpinner('spinner-strat-statement');
  show('btn-strat-statement-cancel');
  hide('strat-statement-save-row');
  setDisabled('btn-strat-statement', true);

  const signal = newAbort();
  try {
    await generateStatement(jobText, {
      signal,
      briefContext: briefToContext(brief), // tailor to criteria + evidence + added experience
      onChunk: chunk => { output.value += chunk; output.scrollTop = output.scrollHeight; }
    });
    show('strat-statement-save-row');
  } catch (err) {
    if (err.name !== 'AbortError') alert(extractErrorMessage(err));
  } finally {
    hideSpinner('spinner-strat-statement');
    hide('btn-strat-statement-cancel');
    setDisabled('btn-strat-statement', false);
  }
}

async function stratStatementSaveHandler() {
  const text = $('strat-statement-output').value.trim();
  if (!text) return;
  const b     = state.currentBrief;
  const label = `Statement — ${[b?.company, b?.jobTitle].filter(Boolean).join(' ') || 'Unnamed'}`;
  chrome.storage.local.get('savedDocs', r => {
    const docs = r.savedDocs || [];
    docs.push({ id: crypto.randomUUID(), label, text, date: new Date().toISOString() });
    chrome.storage.local.set({ savedDocs: docs });
  });
  const btn = $('btn-strat-statement-save');
  btn.textContent = '✓ Saved';
  setTimeout(() => { btn.textContent = 'Save statement'; }, 2000);
}

/** Renders the refinement chat history for a brief. */
function renderChat(brief) {
  const log = $('strat-chat-log');
  log.innerHTML = '';
  for (const m of brief.conversation ?? []) {
    const bubble = document.createElement('div');
    bubble.className = `chat-msg ${m.role}`;
    bubble.textContent = m.text;
    log.appendChild(bubble);
  }
  log.scrollTop = log.scrollHeight;
}

async function stratChatSendHandler() {
  if (!state.currentBrief) return;
  const input = $('strat-chat-input');
  const text  = input.value.trim();
  if (!text) return;

  input.value = '';
  showSpinner('spinner-strat-chat');
  setDisabled('btn-strat-chat-send', true);

  const jobId = state.currentBrief.jobId;
  const signal = newAbort();
  try {
    const { brief } = await chatRefineBrief(jobId, text, signal);
    state.currentBrief = brief;
    await clearStratDraft(jobId); // message sent — drop the saved draft
    renderBrief(brief); // re-renders criteria (re-mapped) + chat log together
  } catch (err) {
    if (err.name !== 'AbortError') {
      input.value = text; // restore the message so it isn't lost
      queueSaveStratDraft(jobId, text); // and keep it saved
      alert(extractErrorMessage(err));
    }
  } finally {
    hideSpinner('spinner-strat-chat');
    setDisabled('btn-strat-chat-send', false);
  }
}

// ── ════════════════════════════════════════════════════════════════════════════
//    SPONSORSHIP TAB
// ═════════════════════════════════════════════════════════════════════════════

function wireSponsorship() {
  $('btn-check-sponsorship').addEventListener('click', checkSponsorshipHandler);

  // Manual employer name search — last resort when extraction fails
  $('btn-employer-override').addEventListener('click', manualEmployerSearchHandler);
  $('employer-override-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') manualEmployerSearchHandler();
  });
}

async function checkSponsorshipHandler() {
  if (!state.currentTab?.id) { return; }

  clearError('error-sponsorship-msg');
  hide('sponsorship-results');
  hide('register-info');
  $('sponsorship-status').textContent = '';
  showSpinner('spinner-sponsorship');
  setDisabled('btn-check-sponsorship', true);

  const signal = newAbort();

  /** Progress callback — shows live status text while the tiers run. */
  const onProgress = msg => { $('sponsorship-status').textContent = msg; };

  try {
    // Always re-extract rather than relying on state.jobData: the sponsorship
    // section on NHS Jobs lives outside the main description container and may
    // not have been captured if jobData was set on an earlier popup open.
    let jobData = null;
    try {
      jobData = await extractJobFromTab(state.currentTab.id);
    } catch (_) {
      jobData = state.jobData; // fall back to cached if content script unreachable
    }
    if (!jobData) throw new Error('Could not extract job details from this page.');

    state.jobData = jobData;

    // Pre-fill the manual search input with whatever was extracted so the user
    // can easily correct it if the name is wrong or wasn't detected.
    const overrideInput = $('employer-override-input');
    if (overrideInput && !overrideInput.value) {
      overrideInput.value = jobData.company ?? '';
    }

    // If extraction gave us no employer, hint that manual search is available.
    if (!jobData.company) {
      $('sponsorship-status').textContent =
        '⚠ Employer name not detected — running register check with empty name. ' +
        'Use the search box below to try manually.';
    }

    const verdict = await analyseSponsorship(jobData, signal, onProgress);
    $('sponsorship-status').textContent = '';   // clear progress text
    state.sponsorshipVerdict = verdict;
    renderSponsorshipVerdict(verdict);
    show('sponsorship-results');

    // Show register cache freshness beneath the verdict
    showRegisterInfo();

    saveSessionCache(); // persist sponsorship verdict

  } catch (err) {
    $('sponsorship-status').textContent = '';
    if (err.name === 'AbortError') return;
    showError('error-sponsorship-msg', 'retry-sponsorship', extractErrorMessage(err), checkSponsorshipHandler);
  } finally {
    hideSpinner('spinner-sponsorship');
    setDisabled('btn-check-sponsorship', false);
  }
}

/**
 * Last-resort: user types an employer name and searches the register directly.
 * Used when the content script couldn't extract the employer, or when the
 * site (e.g. nhsjobs.com) has a different DOM layout than expected.
 */
async function manualEmployerSearchHandler() {
  const name = $('employer-override-input').value.trim();
  if (!name) {
    $('employer-override-input').focus();
    return;
  }

  clearError('error-sponsorship-msg');
  hide('sponsorship-results');
  $('sponsorship-status').textContent = '';
  showSpinner('spinner-sponsorship');
  setDisabled('btn-employer-override', true);
  setDisabled('btn-check-sponsorship', true);

  const signal     = newAbort();
  const onProgress = msg => { $('sponsorship-status').textContent = msg; };

  try {
    const verdict = await checkManualEmployer(
      name, state.jobData ?? {}, signal, onProgress
    );
    $('sponsorship-status').textContent = '';
    state.sponsorshipVerdict = verdict;
    renderSponsorshipVerdict(verdict);
    show('sponsorship-results');
    showRegisterInfo();
    saveSessionCache();
  } catch (err) {
    $('sponsorship-status').textContent = '';
    if (err.name !== 'AbortError') {
      showError('error-sponsorship-msg', 'retry-sponsorship',
        extractErrorMessage(err), null);
    }
  } finally {
    hide('spinner-sponsorship');
    setDisabled('btn-employer-override', false);
    setDisabled('btn-check-sponsorship', false);
  }
}

/** Show when the Register was last downloaded beneath the verdict. */
async function showRegisterInfo() {
  try {
    const r      = await chrome.storage.local.get('jm_sponsorRegister');
    const cached = r['jm_sponsorRegister'];
    if (!cached) return;
    const age  = Math.round((Date.now() - cached.lastUpdated) / 60_000);
    const when = age < 60
      ? `${age} min ago`
      : age < 1440
        ? `${Math.round(age / 60)} h ago`
        : `${Math.round(age / 1440)} day(s) ago`;
    const el = $('register-info');
    el.textContent =
      `Register of Licensed Sponsors: ${cached.count?.toLocaleString() ?? '?'} entries · last updated ${when}`;
    show('register-info');
  } catch (_) {}
}

function renderSponsorshipVerdict(verdict) {
  // Remove any leftover selection UI from a previous run
  document.getElementById('employer-selection-ui')?.remove();
  document.querySelector('.similar-orgs')?.remove();

  // ── Status badge ──────────────────────────────────────────────────────────
  const badge = $('verdict-badge');
  const { label, colour } = verdictBadge(verdict.status);
  badge.style.background = colour;
  badge.textContent = label;

  // ── NEEDS_SELECTION: show the picker and stop here ────────────────────────
  if (verdict.status === 'NEEDS_SELECTION') {
    renderEmployerSelectionUI(verdict);
    // Hide checklist + source links until a final verdict is reached
    $('source-links').innerHTML = '';
    $('checklist-status').innerHTML = '';
    return;
  }

  // ── Key findings — concise, ≤ 3 bullets ──────────────────────────────────
  const reasonsEl = $('reasons-list');
  reasonsEl.innerHTML = '';
  (verdict.reasons ?? []).slice(0, 3).forEach(r => {
    const li = document.createElement('li');
    li.textContent = r;
    reasonsEl.appendChild(li);
  });

  // ── Source link ───────────────────────────────────────────────────────────
  const linksEl = $('source-links');
  if (verdict.sourceUrls?.length) {
    const u = verdict.sourceUrls[0];
    linksEl.innerHTML =
      `<a href="${escHtml(u)}" target="_blank" rel="noopener">` +
      `gov.uk — Register of Licensed Sponsors</a>`;
  } else {
    linksEl.innerHTML = '';
  }

  // ── Sponsorship document checklist ────────────────────────────────────────
  getSponsorshipChecklistStatus(verdict).then(status => {
    const el = $('checklist-status');
    el.innerHTML = '<h4 style="margin-bottom:6px;">Your Sponsorship Documents</h4>';
    [...(status.ready || []).map(i => ({ ...i, s: 'ready' })),
     ...(status.inProgress || []).map(i => ({ ...i, s: 'amber' })),
     ...(status.missing || []).map(i => ({ ...i, s: 'cross' }))
    ].forEach(item => {
      const row = document.createElement('div');
      row.className = 'checklist-row';
      const icon = item.s === 'ready' ? '✓' : item.s === 'amber' ? '!' : '✗';
      const cls  = item.s === 'ready' ? 'icon-tick' : item.s === 'amber' ? 'icon-amber' : 'icon-cross';
      row.innerHTML = `<span class="${cls}">${icon}</span><span>${escHtml(item.label)}</span>`;
      el.appendChild(row);
    });
  }).catch(() => {});
}

/**
 * Render the interactive employer-selection picker for NEEDS_SELECTION status.
 * Inserted after the reasons list inside #sponsorship-results.
 */
function renderEmployerSelectionUI(verdict) {
  const reasonsEl = $('reasons-list');
  reasonsEl.innerHTML = '';
  const intro = document.createElement('li');
  intro.textContent = verdict.reasons?.[0] ?? 'Select the correct organisation:';
  reasonsEl.appendChild(intro);

  const options = [...(verdict.similarEmployers ?? [])];
  if (!options.length) return; // no similar — shouldn't reach here but guard anyway

  const ui = document.createElement('div');
  ui.id        = 'employer-selection-ui';
  ui.className = 'employer-selection-ui';

  // Radio options
  options.forEach((name, i) => {
    const lbl   = document.createElement('label');
    lbl.className = 'emp-option';
    const radio = document.createElement('input');
    radio.type  = 'radio';
    radio.name  = 'emp-select';
    radio.value = name;
    radio.id    = `emp-opt-${i}`;
    lbl.setAttribute('for', radio.id);
    lbl.append(radio, document.createTextNode(' ' + name));
    ui.appendChild(lbl);
  });

  // "None of the above" option
  const noneLabel = document.createElement('label');
  noneLabel.className = 'emp-option emp-option-none';
  const noneRadio = document.createElement('input');
  noneRadio.type  = 'radio';
  noneRadio.name  = 'emp-select';
  noneRadio.value = 'none';
  noneRadio.id    = 'emp-opt-none';
  noneLabel.setAttribute('for', noneRadio.id);
  noneLabel.append(noneRadio, document.createTextNode(' None of the above — run AI search'));
  ui.appendChild(noneLabel);

  // Confirm button
  const btn = document.createElement('button');
  btn.className   = 'btn-primary btn-sm';
  btn.id          = 'btn-confirm-employer';
  btn.textContent = 'Confirm selection';
  ui.appendChild(btn);

  reasonsEl.insertAdjacentElement('afterend', ui);

  btn.addEventListener('click', async () => {
    const checked = ui.querySelector('input[name="emp-select"]:checked');
    if (!checked) { checked || alert('Please select an option first.'); return; }

    ui.remove();
    show('spinner-sponsorship');
    setDisabled('btn-check-sponsorship', true);
    $('sponsorship-status').textContent = checked.value === 'none'
      ? 'Running AI search…'
      : 'Confirming selection…';

    const signal     = newAbort();
    const onProgress = msg => { $('sponsorship-status').textContent = msg; };

    try {
      const finalVerdict = await confirmEmployerSelection(
        checked.value, state.jobData, signal, onProgress
      );
      $('sponsorship-status').textContent = '';
      state.sponsorshipVerdict = finalVerdict;
      renderSponsorshipVerdict(finalVerdict);
      show('sponsorship-results');
      showRegisterInfo();
      saveSessionCache();
    } catch (err) {
      $('sponsorship-status').textContent = '';
      if (err.name !== 'AbortError') {
        showError('error-sponsorship-msg', 'retry-sponsorship',
          extractErrorMessage(err), checkSponsorshipHandler);
      }
    } finally {
      hide('spinner-sponsorship');
      setDisabled('btn-check-sponsorship', false);
    }
  });
}

// ── ════════════════════════════════════════════════════════════════════════════
//    TRACKER TAB
// ═════════════════════════════════════════════════════════════════════════════

function wireTracker() {
  $('stage-filter').addEventListener('change', e => {
    state.stageFilter = e.target.value;
    renderTrackerTable();
  });

  $('btn-export-excel').addEventListener('click', exportExcelHandler);

  // Column sort
  $$('.tracker-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortField = field;
        state.sortDir   = 'asc';
      }
      renderTrackerTable();
    });
  });
}

async function renderTrackerTab() {
  try {
    state.applications = await getApplications();
  } catch (_) {
    state.applications = [];
  }
  renderAnalytics();
  renderTrackerTable();
}

function renderAnalytics() {
  const apps = state.applications;
  const total = apps.length;
  $('stat-total').textContent = total;

  if (!total) {
    $('stat-shortlist').textContent = '—';
    $('stat-interview').textContent = '—';
    hide('tracker-insight');
    return;
  }

  const shortlisted = apps.filter(a =>
    ['Shortlisted', 'Interview Scheduled', 'Interview Done', 'Offer'].includes(a.stage)).length;
  const interviewed = apps.filter(a =>
    ['Interview Scheduled', 'Interview Done', 'Offer'].includes(a.stage)).length;

  $('stat-shortlist').textContent = `${Math.round(shortlisted / total * 100)}%`;
  $('stat-interview').textContent = `${Math.round(interviewed / total * 100)}%`;

  // Simple insight
  if (total >= 3) {
    const avgScore = Math.round(apps.reduce((s, a) => s + (a.matchScore || 0), 0) / total);
    const insight = $('tracker-insight');
    insight.textContent = `Average match score: ${avgScore}%. Shortlist rate: ${Math.round(shortlisted / total * 100)}%.`;
    show('tracker-insight');
  }
}

function renderTrackerTable() {
  const tbody = $('tracker-tbody');
  tbody.innerHTML = '';

  let apps = [...state.applications];

  // Filter
  if (state.stageFilter) {
    apps = apps.filter(a => a.stage === state.stageFilter);
  }

  // Sort
  apps.sort((a, b) => {
    const av = a[state.sortField] ?? '';
    const bv = b[state.sortField] ?? '';
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return state.sortDir === 'asc' ? cmp : -cmp;
  });

  if (!apps.length) {
    show('tracker-empty');
    return;
  }
  hide('tracker-empty');

  const now = Date.now();
  const DAY = 86_400_000;

  for (const app of apps) {
    const tr = document.createElement('tr');

    // Deadline alerts
    const deadline = app.applicationDeadline ? Date.parse(app.applicationDeadline) : null;
    const expiry   = app.jobPostingExpiryDate ? Date.parse(app.jobPostingExpiryDate) : null;
    const noOutcome = ['Applied', 'Shortlisted'].includes(app.stage);

    if (deadline && noOutcome && now > deadline)            tr.className = 'deadline-red';
    else if (deadline && noOutcome && deadline - now < 3 * DAY) tr.className = 'deadline-amber';
    else if (expiry && now > expiry)                         tr.className = 'expiry-grey';

    tr.innerHTML = `
      <td><a href="${escHtml(app.jobSiteUrl || '#')}" target="_blank" rel="noopener"
             style="color:var(--nhs-blue);text-decoration:none;font-weight:600;"
             title="${escHtml(app.jobTitle)}">${escHtml(truncate(app.jobTitle, 28))}</a></td>
      <td>${escHtml(truncate(app.companyName, 20))}</td>
      <td>${app.applicationDeadline ? fmtDate(app.applicationDeadline) : '—'}</td>
      <td><span class="stage-badge stage-${escHtml(app.stage?.replace(/\s/g, '-'))}">${escHtml(app.stage || '—')}</span></td>
      <td>${app.matchScore != null ? app.matchScore + '%' : '—'}</td>
      <td class="row-actions">
        <select class="btn-ghost btn-sm" aria-label="Change stage" data-id="${app.id}">
          ${['Applied','Shortlisted','Interview Scheduled','Interview Done','Offer','Rejected']
            .map(s => `<option${s === app.stage ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn-ghost btn-sm prep-btn" data-id="${app.id}" title="Interview Prep">Prep</button>
        <button class="btn-danger  btn-sm del-btn"  data-id="${app.id}" title="Delete">✕</button>
      </td>`;

    tbody.appendChild(tr);
  }

  // Stage change handler
  $$('#tracker-tbody select[data-id]').forEach(sel => {
    sel.addEventListener('change', async () => {
      try {
        await updateApplication(sel.dataset.id, { stage: sel.value });
        await renderTrackerTab();
      } catch (_) {}
    });
  });

  // Delete handler
  $$('#tracker-tbody .del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this application from the tracker?')) return;
      try {
        await deleteApplication(btn.dataset.id);
        await renderTrackerTab();
      } catch (_) {}
    });
  });

  // Interview prep handler
  $$('#tracker-tbody .prep-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL(`prep/prep.html?appId=${encodeURIComponent(btn.dataset.id)}`)
      });
    });
  });
}

async function exportExcelHandler() {
  try {
    await exportToExcel(state.applications);
  } catch (err) {
    alert(extractErrorMessage(err));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getJobText() {
  if (!state.jobData) return '';
  return [state.jobData.title, state.jobData.company, state.jobData.descriptionText]
    .filter(Boolean).join('\n\n');
}

function cancelCurrentOp() {
  state.activeAbort?.abort();
  hideSpinner('spinner-doc');
  hide('btn-cancel-doc');
}

function openSettings(section, prefill) {
  const url = new URL(chrome.runtime.getURL('settings/settings.html'));
  if (section) url.searchParams.set('section', section);
  if (prefill) url.searchParams.set('prefill', prefill);
  chrome.tabs.create({ url: url.toString() });
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Human-readable relative time, e.g. "just now", "5 min ago", "2 h ago", "3 d ago". */
function timeAgo(ts) {
  if (!ts) return 'earlier';
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} h ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}

function truncate(str, max) {
  str = str ?? '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return iso; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
