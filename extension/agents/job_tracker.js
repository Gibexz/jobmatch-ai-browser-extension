/**
 * Agent 6 — Job Application Tracker
 *
 * Strict responsibility: Recording, storing, and exporting all job applications.
 * Nothing else.
 *
 * Public API:
 *   saveApplication(data)       → Promise<string> (saved id)
 *   getApplications()           → Promise<Array>
 *   updateApplication(id, data) → Promise
 *   deleteApplication(id)       → Promise
 *   exportToExcel(apps)         → Promise (downloads .xlsx)
 *   exportCVTrackerData()       → Promise<{ applications }>
 *   importTrackerData({ applications }) → Promise
 */

const KEY_APPS = 'applications';

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** @returns {Promise<Array>} */
export async function getApplications() {
  const r = await chrome.storage.local.get(KEY_APPS);
  return r[KEY_APPS] ?? [];
}

async function saveApplications(list) {
  await chrome.storage.local.set({ [KEY_APPS]: list });
}

/**
 * Saves a new job application.
 * Creates a deadline alarm if applicationDeadline is set.
 *
 * @param {object} data
 * @returns {Promise<string>} - the saved application id
 */
export async function saveApplication(data) {
  const list = await getApplications();

  const app = {
    id:                   crypto.randomUUID(),
    jobTitle:             data.jobTitle             || '',
    companyName:          data.companyName           || '',
    jobSiteUrl:           data.jobSiteUrl            || '',
    dateSaved:            new Date().toISOString(),
    dateApplied:          data.dateApplied           || new Date().toISOString(),
    jobPostingExpiryDate: data.jobPostingExpiryDate  || '',
    applicationDeadline:  data.applicationDeadline   || '',
    matchScore:           data.matchScore            ?? null,
    sponsorshipVerdict:   data.sponsorshipVerdict    ?? null,
    stage:                data.stage                 || 'Applied',
    notes:                data.notes                 || '',
    documentRef:          data.documentRef           || ''
  };

  list.push(app);
  await saveApplications(list);

  // Alarm fires 24 hours before the deadline so the user has time to act
  if (app.applicationDeadline) {
    const deadlineMs = Date.parse(app.applicationDeadline);
    const alarmAt    = deadlineMs - 86_400_000; // 24 h advance warning
    if (alarmAt > Date.now()) {
      chrome.alarms.create(`deadline-${app.id}`, { when: alarmAt });
    }
  }

  return app.id;
}

/**
 * Updates fields on an existing application.
 * Re-schedules deadline alarm if applicationDeadline changed.
 */
export async function updateApplication(id, data) {
  const list = await getApplications();
  const idx  = list.findIndex(a => a.id === id);
  if (idx < 0) throw new Error('Application not found.');

  const prev = list[idx];
  list[idx]  = { ...prev, ...data };
  await saveApplications(list);

  // Re-schedule alarm if deadline changed
  if (data.applicationDeadline && data.applicationDeadline !== prev.applicationDeadline) {
    chrome.alarms.clear(`deadline-${id}`);
    const deadlineMs = Date.parse(data.applicationDeadline);
    const alarmAt    = deadlineMs - 86_400_000;
    if (alarmAt > Date.now()) {
      chrome.alarms.create(`deadline-${id}`, { when: alarmAt });
    }
  }
}

/** Removes an application and clears its alarm. */
export async function deleteApplication(id) {
  const list = await getApplications();
  await saveApplications(list.filter(a => a.id !== id));
  chrome.alarms.clear(`deadline-${id}`);
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export function computeAnalytics(apps) {
  const total = apps.length;
  if (!total) return { total: 0, byStage: {}, shortlistRate: 0, interviewRate: 0, avgScore: 0, insight: '' };

  const byStage = {};
  for (const a of apps) byStage[a.stage] = (byStage[a.stage] || 0) + 1;

  const shortlistedCount = (byStage['Shortlisted'] || 0) +
    (byStage['Interview Scheduled'] || 0) +
    (byStage['Interview Done'] || 0) +
    (byStage['Offer'] || 0);

  const interviewedCount = (byStage['Interview Scheduled'] || 0) +
    (byStage['Interview Done'] || 0) +
    (byStage['Offer'] || 0);

  const shortlistRate = Math.round(shortlistedCount / total * 100);
  const interviewRate = Math.round(interviewedCount / total * 100);

  const scoredApps = apps.filter(a => a.matchScore != null);
  const avgScore   = scoredApps.length
    ? Math.round(scoredApps.reduce((s, a) => s + a.matchScore, 0) / scoredApps.length)
    : 0;

  // Only generate an insight when there are enough applications to be meaningful
  let insight = '';
  if (total >= 3) {
    if (shortlistRate >= 50) {
      insight = `Strong shortlist rate of ${shortlistRate}% — your applications are resonating well.`;
    } else if (shortlistRate === 0 && total >= 5) {
      insight = `No shortlists yet across ${total} applications. Consider reviewing your CV match scores — look for jobs above 70%.`;
    } else if (avgScore > 0) {
      insight = `Average match score: ${avgScore}%. Aim for jobs above 70% to improve your shortlist rate.`;
    }
  }

  return { total, byStage, shortlistRate, interviewRate, avgScore, insight };
}

// ── Excel export ──────────────────────────────────────────────────────────────

const STAGE_COLOURS = {
  'Applied':             { fgColor: { argb: 'FF1565C0' } }, // blue
  'Shortlisted':         { fgColor: { argb: 'FFF9A825' } }, // yellow
  'Interview Scheduled': { fgColor: { argb: 'FFE65100' } }, // orange
  'Interview Done':      { fgColor: { argb: 'FF1565C0' } }, // blue
  'Offer':               { fgColor: { argb: 'FF2E7D32' } }, // green
  'Rejected':            { fgColor: { argb: 'FF757575' } }  // grey
};

/**
 * Exports all tracked applications to a formatted .xlsx file.
 * Requires globalThis.XLSX (SheetJS) to be available (loaded via script tag in popup.html).
 */
export async function exportToExcel(apps) {
  const XLSX = globalThis.XLSX;
  if (!XLSX) throw new Error('SheetJS (xlsx) is not loaded. Make sure lib/xlsx.min.js is in popup.html.');

  const headers = [
    'Job Title', 'Company', 'Job Site URL', 'Date Saved', 'Date Applied',
    'Deadline', 'Posting Expiry', 'Match Score', 'Sponsorship', 'Stage', 'Notes'
  ];

  const rows = apps.map(a => [
    a.jobTitle,
    a.companyName,
    a.jobSiteUrl,
    a.dateSaved       ? new Date(a.dateSaved).toLocaleDateString('en-GB')       : '',
    a.dateApplied     ? new Date(a.dateApplied).toLocaleDateString('en-GB')     : '',
    a.applicationDeadline  ? new Date(a.applicationDeadline).toLocaleDateString('en-GB')  : '',
    a.jobPostingExpiryDate ? new Date(a.jobPostingExpiryDate).toLocaleDateString('en-GB') : '',
    a.matchScore != null ? `${a.matchScore}%` : '',
    a.sponsorshipVerdict?.status ?? '',
    a.stage,
    a.notes
  ]);

  const wsData = [headers, ...rows];
  const ws     = XLSX.utils.aoa_to_sheet(wsData);

  // Column widths
  ws['!cols'] = [
    { wch: 30 }, { wch: 20 }, { wch: 40 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 22 }, { wch: 20 }, { wch: 40 }
  ];

  // Bold header row
  for (let c = 0; c < headers.length; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) {
      if (!cell.s) cell.s = {};
      cell.s.font = { bold: true };
      cell.s.fill = { patternType: 'solid', fgColor: { argb: 'FF003087' } };
      cell.s.font.color = { argb: 'FFFFFFFF' };
    }
  }

  // Stage colour per row
  apps.forEach((app, rowIdx) => {
    const stageColIdx = 9; // 0-based, "Stage" column
    const cellRef = XLSX.utils.encode_cell({ r: rowIdx + 1, c: stageColIdx });
    const cell = ws[cellRef];
    if (cell && STAGE_COLOURS[app.stage]) {
      if (!cell.s) cell.s = {};
      cell.s.fill = { patternType: 'solid', ...STAGE_COLOURS[app.stage] };
      cell.s.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    }
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Applications');

  const filename = `JobMatchAI_Applications_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ── Backup / Restore ──────────────────────────────────────────────────────────

export async function exportCVTrackerData() {
  const applications = await getApplications();
  return { applications };
}

export async function importTrackerData({ applications }) {
  if (Array.isArray(applications)) {
    await saveApplications(applications);

    // Re-create deadline alarms for future deadlines
    const now = Date.now();
    for (const app of applications) {
      if (app.applicationDeadline && ['Applied', 'Shortlisted'].includes(app.stage)) {
        const deadlineMs = Date.parse(app.applicationDeadline);
        const alarmAt    = deadlineMs - 86_400_000;
        if (alarmAt > now) {
          chrome.alarms.create(`deadline-${app.id}`, { when: alarmAt });
        }
      }
    }
  }
}
