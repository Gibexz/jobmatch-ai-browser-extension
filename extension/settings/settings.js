/**
 * settings.js — Settings page coordinator (Agent 5 — UI Orchestrator)
 *
 * No business logic. Delegates all data operations to agent modules.
 */

import { getActiveCV, getCVList, uploadCV, setActiveCV, deleteCV, renameCV,
         exportCVData, importCVData, getAdditionalDetails, setAdditionalDetails }
  from '../agents/cv_engine.js';

import { getPersonalDetails, savePersonalDetails,
         getSponsorshipChecklist, saveSponsorshipChecklist,
         getExpiryWarnings, exportVaultData, importVaultData }
  from '../agents/personal_vault.js';

import { BUILT_IN_SITES, getCustomSites, addCustomSite, removeCustomSite,
         getAlertProfiles, addAlertProfile, removeAlertProfile,
         exportRegistryData, importRegistryData }
  from '../agents/site_registry.js';

import { getApplications, exportCVTrackerData, importTrackerData }
  from '../agents/job_tracker.js';

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');

function showConfirm(id) {
  show(id);
  setTimeout(() => hide(id), 2500);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Nav highlight on scroll ───────────────────────────────────────────────────

function initNavHighlight() {
  const sections = $$('.settings-section');
  const navItems = $$('.nav-item');

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        navItems.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${entry.target.id}`));
      }
    }
  }, { threshold: 0.3 });

  sections.forEach(s => observer.observe(s));
}

// ── URL params — scroll to section ───────────────────────────────────────────

function handleUrlParams() {
  const params  = new URLSearchParams(location.search);
  const section = params.get('section');
  const prefill = params.get('prefill');

  if (section) {
    const el = document.getElementById(section);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }
  if (prefill && section === 'sites') {
    $('site-pattern').value = prefill;
    $('site-name').focus();
  }
}

// ── ════ API KEY ══════════════════════════════════════════════════════════════

/**
 * Initialises the API key section: loads the stored key, wires show/hide and save buttons.
 */
async function initApiKey() {
  // Always load from local storage first (source of truth), then session fallback
  let key = '';
  try { key = (await chrome.storage.local.get('apiKey')).apiKey ?? ''; } catch (_) {}
  if (!key) {
    try { key = (await chrome.storage.session.get('apiKey')).apiKey ?? ''; } catch (_) {}
  }
  $('api-key-input').value = key;

  // Show current key status
  updateApiKeyStatus(key);

  $('toggle-api-key').addEventListener('click', () => {
    const inp = $('api-key-input');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('toggle-api-key').textContent = show ? 'Hide' : 'Show';
  });

  $('save-api-key').addEventListener('click', async () => {
    const key = $('api-key-input').value.trim();
    if (!key) { alert('Please enter an API key.'); return; }
    // Save to local storage first (primary), then session (cache)
    await chrome.storage.local.set({ apiKey: key });
    chrome.storage.session.set({ apiKey: key }).catch(() => {});
    updateApiKeyStatus(key);
    showConfirm('confirm-api-key');
    // Hide any previous test result
    hide('confirm-api-test');
    hide('fail-api-test');
  });

  $('test-api-key').addEventListener('click', async () => {
    const btn = $('test-api-key');
    hide('confirm-api-test');
    hide('fail-api-test');
    btn.disabled = true;
    btn.textContent = 'Testing…';

    // Use the persisted key for the test, not the input value — the user may not have saved yet
    let storedKey = '';
    try { storedKey = (await chrome.storage.local.get('apiKey')).apiKey ?? ''; } catch (_) {}
    if (!storedKey) storedKey = $('api-key-input').value.trim();

    if (!storedKey) {
      alert('Please enter and save an API key first.');
      btn.disabled = false;
      btn.textContent = 'Test connection';
      return;
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type':      'application/json',
          'x-api-key':         storedKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 5,
          messages:   [{ role: 'user', content: 'Hi' }]
        })
      });

      const body = await res.json().catch(() => ({}));
      const apiMsg = body?.error?.message ?? '';

      if (res.ok) {
        show('confirm-api-test');
      } else if (res.status === 401) {
        const failEl = $('fail-api-test');
        failEl.textContent = `✗ 401 Unauthorized — ${apiMsg || 'invalid API key'}`;
        show('fail-api-test');
      } else if (res.status === 529) {
        // 529 = Anthropic overloaded; the key was accepted so treat as success
        show('confirm-api-test');
      } else {
        // 400 bad request etc — key was accepted, minor request issue
        const failEl = $('fail-api-test');
        if (res.status === 400 && apiMsg) {
          failEl.textContent = `Key accepted but request error: ${apiMsg}`;
          failEl.style.color = 'var(--nhs-orange)';
        } else {
          failEl.textContent = `✗ Status ${res.status} — ${apiMsg}`;
        }
        show('fail-api-test');
      }
    } catch (err) {
      alert('Network error: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Test connection';
  });
}

function updateApiKeyStatus(key) {
  const el = $('api-key-status');
  if (!el) return;
  if (key) {
    const masked = key.slice(0, 14) + '…' + key.slice(-4);
    el.textContent = `Currently stored: ${masked}`;
    el.style.color = 'var(--nhs-green)';
  } else {
    el.textContent = 'No API key stored yet.';
    el.style.color = 'var(--nhs-red)';
  }
}

// ── ════ CV MANAGEMENT ════════════════════════════════════════════════════════

let _parsedCVText = '';

async function initCVManagement() {
  await renderCVList();

  // Additional details — optional free-text supplement to the active CV
  $('cv-additional').value = await getAdditionalDetails();
  $('btn-save-additional').addEventListener('click', async () => {
    await setAdditionalDetails($('cv-additional').value);
    showConfirm('confirm-save-additional');
  });

  // File picker → extract text on selection
  $('cv-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { parseCV } = await import('../agents/cv_engine.js');
      _parsedCVText = await parseCV(file);
      $('cv-preview').textContent = _parsedCVText.slice(0, 1500);
      show('cv-preview-wrap');
    } catch (err) {
      alert(err.message);
    }
  });

  $('btn-preview-cv').addEventListener('click', async () => {
    const pasteText = $('cv-paste').value.trim();
    if (pasteText) {
      _parsedCVText = pasteText;
      $('cv-preview').textContent = pasteText.slice(0, 1500);
      show('cv-preview-wrap');
    } else if ($('cv-file').files?.[0]) {
      // already handled above
    } else {
      alert('Please upload a file or paste CV text first.');
    }
  });

  $('btn-add-cv').addEventListener('click', async () => {
    const label    = $('cv-label').value.trim();
    const pasteText = $('cv-paste').value.trim();
    const fileInput = $('cv-file').files?.[0];

    if (!label) { alert('Please enter a label for this CV.'); return; }
    const input = fileInput || pasteText || _parsedCVText;
    if (!input) { alert('Please upload a file or paste CV text.'); return; }

    try {
      await uploadCV(input, label);
      $('cv-label').value  = '';
      $('cv-paste').value  = '';
      $('cv-file').value   = '';
      _parsedCVText        = '';
      hide('cv-preview-wrap');
      showConfirm('confirm-add-cv');
      await renderCVList();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function renderCVList() {
  const [list, active] = await Promise.all([getCVList(), getActiveCV()]);
  const el = $('cv-list');
  el.innerHTML = '';

  if (!list.length) {
    el.innerHTML = '<div class="empty-state" id="cv-empty">No CVs stored yet.</div>';
    return;
  }

  for (const cv of list) {
    const isActive = cv.id === active?.id;
    const item = document.createElement('div');
    item.className = `cv-item${isActive ? ' is-active' : ''}`;
    item.innerHTML = `
      <div>
        <div class="cv-label">${escHtml(cv.label)}${isActive ? ' <em style="font-weight:400;color:var(--nhs-green);">(active)</em>' : ''}</div>
        <div class="cv-meta">Added ${new Date(cv.dateAdded).toLocaleDateString('en-GB')}</div>
      </div>
      <div class="cv-item-actions">
        ${!isActive ? `<button class="btn-secondary btn-sm" data-id="${cv.id}" data-action="activate">Set active</button>` : ''}
        <button class="btn-ghost btn-sm" data-id="${cv.id}" data-action="rename">Rename</button>
        <button class="btn-danger btn-sm" data-id="${cv.id}" data-action="delete">Delete</button>
      </div>`;
    el.appendChild(item);
  }

  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { id, action } = btn.dataset;

    if (action === 'activate') {
      await setActiveCV(id);
      await renderCVList();
    }
    if (action === 'rename') {
      const newLabel = prompt('Enter new label:');
      if (newLabel?.trim()) { await renameCV(id, newLabel); await renderCVList(); }
    }
    if (action === 'delete') {
      if (!confirm('Delete this CV? This cannot be undone.')) return;
      await deleteCV(id);
      await renderCVList();
    }
  });
}

// ── ════ PERSONAL DETAILS ═════════════════════════════════════════════════════

async function initPersonalDetails() {
  const details = await getPersonalDetails();
  populatePersonalForm(details);

  // Expiry warnings
  const warnings = await getExpiryWarnings();
  const warnEl   = $('expiry-warnings');
  for (const w of warnings) {
    const box = document.createElement('div');
    box.className = w.severity === 'error' ? 'error-box' : 'warning-box';
    box.textContent = w.message;
    warnEl.appendChild(box);
  }

  // Diversity "prefer not to say" toggle
  $('p-diversity-prefer-not').addEventListener('change', e => {
    $('diversity-fields').style.opacity = e.target.checked ? '.4' : '1';
    $$('#diversity-fields input, #diversity-fields select').forEach(el => el.disabled = e.target.checked);
  });

  // NI show/hide
  $('toggle-ni').addEventListener('click', () => {
    const ni = $('p-ni');
    ni.type = ni.type === 'password' ? 'text' : 'password';
    $('toggle-ni').textContent = ni.type === 'password' ? 'Show' : 'Hide';
  });

  $('save-personal').addEventListener('click', async () => {
    try {
      await savePersonalDetails(collectPersonalForm());
      showConfirm('confirm-personal');
    } catch (err) {
      alert(err.message);
    }
  });
}

function populatePersonalForm(d) {
  const set = (id, val) => { const el = $(id); if (el) el.value = val ?? ''; };
  set('p-name',      d.fullLegalName);
  set('p-email',     d.email);
  set('p-phone',     d.phone);
  set('p-ni',        d.nationalInsuranceNumber);
  set('p-addr1',     d.address?.line1);
  set('p-addr2',     d.address?.line2);
  set('p-city',      d.address?.city);
  set('p-postcode',  d.address?.postcode);
  set('p-country',   d.address?.country || 'United Kingdom');
  set('p-reg-type',  d.professionalRegistration?.type);
  set('p-reg-num',   d.professionalRegistration?.number);
  set('p-reg-exp',   d.professionalRegistration?.expiryDate);
  set('p-rtw-status',d.rightToWork?.status);
  set('p-visa-type', d.rightToWork?.visaType);
  set('p-visa-exp',  d.rightToWork?.visaExpiryDate);
  set('r1-name',     d.referee1?.name);
  set('r1-title',    d.referee1?.jobTitle);
  set('r1-org',      d.referee1?.organisation);
  set('r1-email',    d.referee1?.email);
  set('r1-phone',    d.referee1?.phone);
  set('r1-rel',      d.referee1?.relationship);
  set('r2-name',     d.referee2?.name);
  set('r2-title',    d.referee2?.jobTitle);
  set('r2-org',      d.referee2?.organisation);
  set('r2-email',    d.referee2?.email);
  set('r2-phone',    d.referee2?.phone);
  set('r2-rel',      d.referee2?.relationship);
  set('p-gender',    d.diversityPreferences?.gender);
  set('p-ethnicity', d.diversityPreferences?.ethnicity);
  set('p-disability',d.diversityPreferences?.disability);
  set('p-sexuality', d.diversityPreferences?.sexualOrientation);
  set('p-religion',  d.diversityPreferences?.religion);
  set('p-driving',   d.drivingLicence?.status);
  if (d.diversityPreferences?.preferNotToSay) {
    $('p-diversity-prefer-not').checked = true;
    $('diversity-fields').style.opacity = '.4';
    $$('#diversity-fields input, #diversity-fields select').forEach(el => el.disabled = true);
  }
}

function collectPersonalForm() {
  const val = id => $(id)?.value?.trim() ?? '';
  return {
    fullLegalName: val('p-name'),
    address: { line1: val('p-addr1'), line2: val('p-addr2'), city: val('p-city'), postcode: val('p-postcode'), country: val('p-country') },
    phone: val('p-phone'),
    email: val('p-email'),
    professionalRegistration: { type: val('p-reg-type'), number: val('p-reg-num'), expiryDate: val('p-reg-exp') },
    rightToWork: { status: val('p-rtw-status'), visaType: val('p-visa-type'), visaExpiryDate: val('p-visa-exp') },
    nationalInsuranceNumber: val('p-ni'),
    referee1: { name: val('r1-name'), jobTitle: val('r1-title'), organisation: val('r1-org'), email: val('r1-email'), phone: val('r1-phone'), relationship: val('r1-rel') },
    referee2: { name: val('r2-name'), jobTitle: val('r2-title'), organisation: val('r2-org'), email: val('r2-email'), phone: val('r2-phone'), relationship: val('r2-rel') },
    diversityPreferences: {
      gender: val('p-gender'), ethnicity: val('p-ethnicity'), disability: val('p-disability'),
      sexualOrientation: val('p-sexuality'), religion: val('p-religion'),
      preferNotToSay: $('p-diversity-prefer-not')?.checked ?? false
    },
    drivingLicence: { status: val('p-driving'), categories: '' }
  };
}

// ── ════ SPONSORSHIP CHECKLIST ════════════════════════════════════════════════

async function initSponsorshipChecklist() {
  const checklist = await getSponsorshipChecklist();
  renderChecklist(checklist);

  $('save-checklist').addEventListener('click', async () => {
    const updated = collectChecklist();
    await saveSponsorshipChecklist(updated);
    showConfirm('confirm-checklist');
  });
}

function renderChecklist(checklist) {
  const el = $('checklist-list');
  el.innerHTML = '';

  for (const item of checklist) {
    const cls = item.status === 'Have it' ? 'status-have-it'
              : item.status === 'In progress' ? 'status-in-progress'
              : 'status-missing';
    const hasExpiry = ['passport', 'english', 'registration', 'tb'].includes(item.id);
    const div = document.createElement('div');
    div.className = `checklist-item ${cls}`;
    div.dataset.id = item.id;
    div.innerHTML = `
      <div class="cl-label">${escHtml(item.label)}</div>
      <div class="cl-row-fields">
        <div class="field-group">
          <label>Status</label>
          <select class="cl-status" data-id="${item.id}">
            <option${item.status === 'Have it'     ? ' selected' : ''}>Have it</option>
            <option${item.status === 'In progress' ? ' selected' : ''}>In progress</option>
            <option${item.status === 'Missing'     ? ' selected' : ''}>Missing</option>
          </select>
        </div>
        <div class="field-group">
          <label>Notes</label>
          <input type="text" class="cl-notes" data-id="${item.id}" value="${escHtml(item.notes || '')}">
        </div>
        ${hasExpiry ? `
        <div class="field-group">
          <label>Expiry date</label>
          <input type="date" class="cl-expiry" data-id="${item.id}" value="${escHtml(item.expiryDate || '')}">
        </div>` : '<div></div>'}
        ${item.id === 'english' ? `
        <div class="field-group">
          <label>Score (e.g. IELTS 7.5)</label>
          <input type="text" class="cl-score" data-id="${item.id}" value="${escHtml(item.score || '')}">
        </div>` : ''}
      </div>`;

    // Live border colour update on status change
    div.querySelector('.cl-status').addEventListener('change', e => {
      div.className = `checklist-item ${e.target.value === 'Have it' ? 'status-have-it' : e.target.value === 'In progress' ? 'status-in-progress' : 'status-missing'}`;
    });

    el.appendChild(div);
  }
}

function collectChecklist() {
  return [...$$('.checklist-item[data-id]')].map(div => {
    const id = div.dataset.id;
    return {
      id,
      status:     div.querySelector('.cl-status')?.value ?? 'Missing',
      notes:      div.querySelector('.cl-notes')?.value  ?? '',
      expiryDate: div.querySelector('.cl-expiry')?.value ?? '',
      score:      div.querySelector('.cl-score')?.value  ?? ''
    };
  });
}

// ── ════ JOB SITES ════════════════════════════════════════════════════════════

async function initJobSites() {
  // Built-in
  const builtInEl = $('builtin-sites-list');
  BUILT_IN_SITES.forEach(s => {
    const row = document.createElement('div');
    row.className = 'site-item';
    row.innerHTML = `
      <span class="site-name">${escHtml(s.name)}</span>
      <span class="site-pattern">${escHtml(s.pattern)}</span>
      <span class="site-type-badge">${s.type}</span>`;
    builtInEl.appendChild(row);
  });

  await renderCustomSites();

  $('btn-add-site').addEventListener('click', async () => {
    const name    = $('site-name').value.trim();
    const pattern = $('site-pattern').value.trim();
    const type    = $('site-type').value;
    if (!name || !pattern) { alert('Please enter both a site name and URL pattern.'); return; }
    try {
      await addCustomSite({ name, pattern, type });
      $('site-name').value = $('site-pattern').value = '';
      showConfirm('confirm-site');
      await renderCustomSites();
    } catch (err) { alert(err.message); }
  });
}

async function renderCustomSites() {
  const list = await getCustomSites();
  const el   = $('custom-sites-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="empty-state" id="custom-sites-empty">No custom sites added yet.</div>';
    return;
  }
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'site-item';
    row.innerHTML = `
      <span class="site-name">${escHtml(s.name)}</span>
      <span class="site-pattern">${escHtml(s.pattern)}</span>
      <span class="site-type-badge">${s.type}</span>
      <button class="btn-danger btn-sm" data-id="${s.id}">Remove</button>`;
    el.appendChild(row);
  }
  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    if (!confirm('Remove this custom site?')) return;
    await removeCustomSite(btn.dataset.id);
    await renderCustomSites();
  });
}

// ── ════ JOB ALERT PROFILES ═══════════════════════════════════════════════════

async function initAlertProfiles() {
  await renderAlertProfiles();

  $('btn-add-alert').addEventListener('click', async () => {
    const kwStr = $('alert-keywords').value.trim();
    if (!kwStr) { alert('Please enter at least one keyword.'); return; }
    const keywords = kwStr.split(',').map(k => k.trim()).filter(Boolean);
    try {
      await addAlertProfile({
        keywords,
        location:           $('alert-location').value.trim(),
        salaryMin:          parseInt($('alert-salary-min').value) || null,
        salaryMax:          parseInt($('alert-salary-max').value) || null,
        requireSponsorship: $('alert-sponsorship').checked
      });
      $('alert-keywords').value = $('alert-location').value = '';
      $('alert-salary-min').value = $('alert-salary-max').value = '';
      $('alert-sponsorship').checked = false;
      showConfirm('confirm-alert');
      await renderAlertProfiles();
    } catch (err) { alert(err.message); }
  });
}

async function renderAlertProfiles() {
  const list = await getAlertProfiles();
  const el   = $('alerts-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="empty-state" id="alerts-empty">No alert profiles yet.</div>';
    return;
  }
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'alert-item';
    const details = [
      p.location && `📍 ${p.location}`,
      p.salaryMin && `£${p.salaryMin.toLocaleString()}+`,
      p.requireSponsorship && '🌐 Sponsorship required'
    ].filter(Boolean).join('  ·  ');
    row.innerHTML = `
      <div class="alert-meta">
        <div class="alert-kw">${escHtml(p.keywords.join(', '))}</div>
        ${details ? `<div class="alert-details">${escHtml(details)}</div>` : ''}
      </div>
      <button class="btn-danger btn-sm" data-id="${p.id}">Remove</button>`;
    el.appendChild(row);
  }
  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    if (!confirm('Remove this alert profile?')) return;
    await removeAlertProfile(btn.dataset.id);
    await renderAlertProfiles();
  });
}

// ── ════ CAREER GOALS ═════════════════════════════════════════════════════════

async function initGoals() {
  await renderGoals();
}

async function renderGoals() {
  const { goals = [] } = await chrome.storage.local.get('goals');
  const el = $('goals-list');
  el.innerHTML = '';
  if (!goals.length) {
    el.innerHTML = '<div class="empty-state" id="goals-empty">No goals saved yet.</div>';
    return;
  }
  for (const g of goals) {
    const row = document.createElement('div');
    row.className = `goal-item${g.status === 'completed' ? ' completed' : ''}`;
    row.innerHTML = `
      <div>
        <div class="goal-text">${escHtml(g.text)}</div>
        <div class="goal-meta">From: ${escHtml(g.source || 'Advisor')} · ${new Date(g.dateAdded).toLocaleDateString('en-GB')}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        ${g.status !== 'completed' ? `<button class="btn-secondary btn-sm" data-id="${g.id}" data-action="complete">✓ Done</button>` : ''}
        <button class="btn-danger btn-sm" data-id="${g.id}" data-action="dismiss">Remove</button>
      </div>`;
    el.appendChild(row);
  }
  el.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { goals = [] } = await chrome.storage.local.get('goals');
    const g = goals.find(x => x.id === btn.dataset.id);
    if (!g) return;
    if (btn.dataset.action === 'complete') g.status = 'completed';
    if (btn.dataset.action === 'dismiss')  goals.splice(goals.indexOf(g), 1);
    await chrome.storage.local.set({ goals });
    await renderGoals();
  });
}

// ── ════ BACKUP & RESTORE ═════════════════════════════════════════════════════

async function initBackupRestore() {
  $('btn-export-backup').addEventListener('click', async () => {
    try {
      const [cvData, vaultData, trackerData, registryData, goals] = await Promise.all([
        exportCVData(),
        exportVaultData(),
        getApplications().then(apps => ({ applications: apps })).catch(() => ({ applications: [] })),
        exportRegistryData(),
        chrome.storage.local.get('goals').then(r => r.goals || [])
      ]);

      const backup = {
        version:    '1.0',
        exportDate: new Date().toISOString(),
        cvData,
        vaultData,
        trackerData,
        registryData,
        goals
      };

      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `JobMatchAI_Backup_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      $('backup-error').textContent = err.message;
      show('backup-error');
    }
  });

  $('backup-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text   = await file.text();
      const backup = JSON.parse(text);

      // version field is used as the presence check for a valid backup envelope
      if (!backup.version) throw new Error('This does not appear to be a valid JobMatch AI backup file.');

      const confirmed = confirm(
        `Import backup from ${new Date(backup.exportDate).toLocaleDateString('en-GB')}?\n` +
        'This will replace all current data. Your API key will not be affected.'
      );
      if (!confirmed) return;

      await Promise.all([
        backup.cvData       && importCVData(backup.cvData),
        backup.vaultData    && importVaultData(backup.vaultData),
        backup.trackerData  && importTrackerData(backup.trackerData),
        backup.registryData && importRegistryData(backup.registryData),
        backup.goals        && chrome.storage.local.set({ goals: backup.goals })
      ].filter(Boolean));

      showConfirm('confirm-backup');
      // Reload to reflect restored data
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      $('backup-error').textContent = `Import failed: ${err.message}`;
      show('backup-error');
    }
    e.target.value = '';
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  initNavHighlight();
  handleUrlParams();

  await Promise.all([
    initApiKey(),
    initCVManagement(),
    initPersonalDetails(),
    initSponsorshipChecklist(),
    initJobSites(),
    initAlertProfiles(),
    initGoals(),
    initBackupRestore()
  ]);
}

document.addEventListener('DOMContentLoaded', init);
