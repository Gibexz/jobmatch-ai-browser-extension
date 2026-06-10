/**
 * prep.js — Interview Prep Coach page (Agent 8 UI)
 *
 * Opens via: chrome.tabs.create({ url: 'prep/prep.html?appId=...' })
 * Loads or generates a prep session, then renders the interactive Q&A.
 */

import { generatePrepSession, getPrepProgress,
         savePrepProgress, streamFollowUp }
  from '../agents/interview_prep.js';
import { getApplications } from '../agents/job_tracker.js';

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── State ─────────────────────────────────────────────────────────────────────
let appId   = null;
let session = null;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  appId = new URLSearchParams(location.search).get('appId');
  if (!appId) {
    showError('No application ID specified. Please open prep from the Job Tracker.');
    return;
  }

  // Find app details for header
  try {
    const apps = await getApplications();
    const app  = apps.find(a => a.id === appId);
    if (app) {
      $('hd-job-title').textContent  = app.jobTitle;
      $('meta-job-title').textContent = app.jobTitle;
      $('meta-company').textContent  = app.companyName;
    }
  } catch (_) {}

  // Load existing session first to avoid a redundant API call on re-open
  $('loading-msg').textContent = 'Loading your interview prep session…';
  try {
    session = await getPrepProgress(appId);
    if (session) {
      renderSession(session);
    } else {
      // No saved session — generate one fresh (takes ~30 s due to parallel Claude calls)
      $('loading-msg').textContent = 'Generating tailored interview prep (this takes ~30 seconds)…';
      session = await generatePrepSession(appId);
      renderSession(session);
    }
  } catch (err) {
    showError(err.message);
  }

  $('btn-regenerate').addEventListener('click', regenerate);
}

async function regenerate() {
  hide('prep-content');
  show('loading-state');
  $('loading-msg').textContent = 'Regenerating interview prep session…';
  try {
    session = await generatePrepSession(appId);
    renderSession(session);
  } catch (err) {
    showError(err.message);
  }
}

function showError(msg) {
  hide('loading-state');
  $('prep-error').textContent = msg;
  show('prep-error');
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderSession(s) {
  hide('loading-state');
  hide('prep-error');
  renderQuestions(s.questions   || []);
  renderResearch(s.researchPoints || []);
  renderRedFlags(s.redFlags     || []);
  renderResources(s.resources   || []);
  show('prep-content');
}

// ── Questions ─────────────────────────────────────────────────────────────────

function renderQuestions(questions) {
  const list = $('questions-list');
  list.innerHTML = '';
  $('q-count').textContent = `(${questions.length})`;

  for (const q of questions) {
    const item = document.createElement('div');
    item.className = 'question-item';
    item.dataset.qid = q.id;

    const catClass = `cat-${(q.category || 'Competency').replace(/\s+/g, '-')}`;

    item.innerHTML = `
      <div class="question-hd" role="button" tabindex="0" aria-expanded="false">
        <span class="cat-badge ${catClass}">${escHtml(q.category)}</span>
        <span class="question-text">${escHtml(q.question)}</span>
        <label class="practised-cb" onclick="event.stopPropagation()">
          <input type="checkbox" class="practised-check" data-qid="${escHtml(q.id)}"
                 ${q.practised ? 'checked' : ''} aria-label="Mark as practised">
          Practised
        </label>
      </div>
      <div class="question-body${q.practised ? ' open' : ''}" id="body-${escHtml(q.id)}">
        <div class="answer-box">${escHtml(q.suggestedAnswer)}</div>
        ${q.notes ? `<div class="notes-box">💡 ${escHtml(q.notes)}</div>` : ''}
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
          <span style="font-size:12px;color:var(--muted);">Ask a follow-up:</span>
          <button class="btn-ghost btn-sm followup-trigger" data-qid="${escHtml(q.id)}">
            Improve this answer
          </button>
        </div>
        <div class="followup-area" id="followup-area-${escHtml(q.id)}" style="display:none;">
          <input class="followup-input" type="text" placeholder="e.g. Make it shorter / add a specific example…"
                 id="followup-input-${escHtml(q.id)}" aria-label="Follow-up request">
          <button class="btn-secondary btn-sm followup-send" data-qid="${escHtml(q.id)}">Send</button>
        </div>
        <div class="followup-response hidden" id="followup-resp-${escHtml(q.id)}"></div>
      </div>`;

    list.appendChild(item);

    // Toggle body on header click
    const hd = item.querySelector('.question-hd');
    hd.addEventListener('click', () => {
      const body    = item.querySelector('.question-body');
      const isOpen  = body.classList.toggle('open');
      hd.setAttribute('aria-expanded', String(isOpen));
    });
    hd.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hd.click(); } });

    // Practised checkbox
    const cb = item.querySelector('.practised-check');
    cb.addEventListener('change', async () => {
      const qRef = session.questions.find(x => x.id === q.id);
      if (qRef) qRef.practised = cb.checked;
      await savePrepProgress(appId, { questions: session.questions });
    });

    // Follow-up trigger
    item.querySelector('.followup-trigger').addEventListener('click', () => {
      const area = $(`followup-area-${q.id}`);
      area.style.display = area.style.display === 'none' ? 'flex' : 'none';
      if (area.style.display === 'flex') $(`followup-input-${q.id}`).focus();
    });

    // Follow-up send
    item.querySelector('.followup-send').addEventListener('click', () => sendFollowUp(q));
    $(`followup-input-${q.id}`).addEventListener('keydown', e => {
      if (e.key === 'Enter') sendFollowUp(q);
    });
  }
}

async function sendFollowUp(q) {
  const inputEl = $(`followup-input-${q.id}`);
  const respEl  = $(`followup-resp-${q.id}`);
  const request = inputEl.value.trim();
  if (!request) return;

  respEl.textContent = '';
  show(`followup-resp-${q.id}`);
  respEl.style.opacity = '.6';

  const context = {
    question:      q.question,
    currentAnswer: q.suggestedAnswer
  };

  try {
    const full = await streamFollowUp(request, context, {
      onChunk: chunk => { respEl.textContent += chunk; }
    });
    // Persist follow-ups so they survive page refreshes
    if (!q.followUps) q.followUps = [];
    q.followUps.push({ request, response: full, date: new Date().toISOString() });
    await savePrepProgress(appId, { questions: session.questions });
  } catch (err) {
    respEl.textContent = `Error: ${err.message}`;
  }
  respEl.style.opacity = '1';
  inputEl.value = '';
}

// ── Research checklist ────────────────────────────────────────────────────────

function renderResearch(points) {
  const list = $('research-list');
  list.innerHTML = '';
  if (!points.length) { list.innerHTML = '<p style="color:var(--muted);font-size:13px;">No research points generated.</p>'; return; }

  for (let i = 0; i < points.length; i++) {
    const pt   = typeof points[i] === 'string' ? { text: points[i], researched: false } : points[i];
    const item = document.createElement('div');
    item.className = `checklist-item${pt.researched ? ' done' : ''}`;
    const cbId = `rc-${i}`;
    item.innerHTML = `
      <input type="checkbox" id="${cbId}" ${pt.researched ? 'checked' : ''} aria-label="Mark as researched">
      <label for="${cbId}">${escHtml(pt.text || pt)}</label>`;
    const cb = item.querySelector('input');
    cb.addEventListener('change', async () => {
      item.classList.toggle('done', cb.checked);
      session.researchPoints[i] = { text: pt.text || pt, researched: cb.checked };
      await savePrepProgress(appId, { researchPoints: session.researchPoints });
    });
    list.appendChild(item);
  }
}

// ── Red flags ─────────────────────────────────────────────────────────────────

function renderRedFlags(flags) {
  const list = $('redflags-list');
  list.innerHTML = '';
  if (!flags.length) { list.innerHTML = '<p style="color:var(--muted);font-size:13px;">No significant weak points identified — great!</p>'; return; }

  for (let i = 0; i < flags.length; i++) {
    const f    = flags[i];
    const item = document.createElement('div');
    item.className = `redflag-item${f.prepared ? ' prepared' : ''}`;
    item.innerHTML = `
      <div class="redflag-issue">⚠ ${escHtml(f.issue)}</div>
      <div class="redflag-response">${escHtml(f.suggestedResponse)}</div>
      <div style="margin-top:8px;">
        <button class="btn-ghost btn-sm prepared-btn" data-idx="${i}">
          ${f.prepared ? '✓ Prepared' : 'Mark as prepared'}
        </button>
      </div>`;
    item.querySelector('.prepared-btn').addEventListener('click', async btn => {
      session.redFlags[i].prepared = !session.redFlags[i].prepared;
      await savePrepProgress(appId, { redFlags: session.redFlags });
      renderRedFlags(session.redFlags); // re-render
    });
    list.appendChild(item);
  }
}

// ── Study resources ───────────────────────────────────────────────────────────

function renderResources(resources) {
  const list = $('resources-list');
  list.innerHTML = '';
  if (!resources.length) { list.innerHTML = '<p style="color:var(--muted);font-size:13px;">No study resources generated for this role.</p>'; return; }

  for (const r of resources) {
    const item = document.createElement('div');
    item.className = 'resource-item';
    item.innerHTML = `
      <span class="res-cat">${escHtml(r.category)}</span>
      <div class="res-body">
        <div class="res-title">
          ${r.url
            ? `<a href="${escHtml(r.url)}" target="_blank" rel="noopener">${escHtml(r.title)}</a>`
            : `<strong>${escHtml(r.title)}</strong>`}
        </div>
        <div class="res-rel">${escHtml(r.relevance)}</div>
      </div>`;
    list.appendChild(item);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
