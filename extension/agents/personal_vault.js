/**
 * Agent 9 — Personal Details Vault & Sponsorship Document Tracker
 *
 * Strict responsibility: Storing the user's personal reusable details and
 * tracking sponsorship readiness documents. Nothing else.
 *
 * Exposes:
 *   getPersonalDetails()        → full personal details object
 *   savePersonalDetails(data)   → persists personal details
 *   getSponsorshipChecklist()   → full checklist array
 *   saveSponsorshipChecklist(c) → persists checklist
 *   getSponsorshipReadiness()   → { score, ready, inProgress, missing }
 *   getExpiryWarnings()         → array of { field, message, severity }
 *   maskNI(string)              → masked NI number for display
 */

// ── Storage keys ──────────────────────────────────────────────────────────────
const KEY_PERSONAL  = 'personalDetails';
const KEY_CHECKLIST = 'sponsorshipChecklist';

// ── Default structures ────────────────────────────────────────────────────────

const DEFAULT_PERSONAL_DETAILS = {
  fullLegalName: '',
  address: {
    line1:    '',
    line2:    '',
    city:     '',
    postcode: '',
    country:  'United Kingdom'
  },
  phone: '',
  email: '',
  professionalRegistration: {
    type:       '', // "NMC" | "HCPC" | "GMC" | "Other"
    number:     '',
    expiryDate: ''
  },
  rightToWork: {
    status:         '', // "UK Citizen" | "ILR" | "Skilled Worker Visa" | "Other"
    visaType:       '',
    visaExpiryDate: ''
  },
  nationalInsuranceNumber: '',
  referee1: {
    name:         '',
    jobTitle:     '',
    organisation: '',
    email:        '',
    phone:        '',
    relationship: ''
  },
  referee2: {
    name:         '',
    jobTitle:     '',
    organisation: '',
    email:        '',
    phone:        '',
    relationship: ''
  },
  diversityPreferences: {
    gender:          '',
    ethnicity:       '',
    disability:      '',
    sexualOrientation: '',
    religion:        '',
    preferNotToSay:  false // when true, form_filler sends "Prefer not to say" for every diversity question
  },
  drivingLicence: {
    status:     '', // "Full UK" | "Provisional" | "International" | "None"
    categories: '' // e.g. "B, BE"
  }
};

// Canonical checklist — one entry per required sponsorship document.
// The id field is stable; label/notes/status are user-editable.
const DEFAULT_CHECKLIST = [
  {
    id:         'passport',
    label:      'Valid passport',
    status:     'Missing',
    notes:      '',
    expiryDate: ''
  },
  {
    id:         'english',
    label:      'English language proof (IELTS / OET or exemption)',
    status:     'Missing',
    notes:      '',
    score:      '',   // e.g. "IELTS 7.5 overall"
    testDate:   '',
    expiryDate: ''
  },
  {
    id:         'registration',
    label:      'HCPC / NMC professional registration',
    status:     'Missing',
    notes:      '',
    expiryDate: ''   // synced from personalDetails.professionalRegistration.expiryDate on save
  },
  {
    id:     'cos',
    label:  'Certificate of Sponsorship — understands the process',
    status: 'Missing',
    notes:  ''
  },
  {
    id:         'tb',
    label:      'Tuberculosis (TB) test result (if applicable)',
    status:     'Missing',
    notes:      '',
    expiryDate: ''
  },
  {
    id:     'qualifications',
    label:  'Academic qualifications / degree certificates',
    status: 'Missing',
    notes:  ''
  },
  {
    id:     'additional',
    label:  'Additional role-specific documents',
    status: 'Missing',
    notes:  ''
  }
];

// ── Personal Details ──────────────────────────────────────────────────────────

/**
 * Returns stored personal details, merged with defaults so any new fields
 * added in updates are always present.
 */
export async function getPersonalDetails() {
  const result = await chrome.storage.local.get(KEY_PERSONAL);
  const stored = result[KEY_PERSONAL];
  if (!stored) return deepClone(DEFAULT_PERSONAL_DETAILS);

  // Deep merge: stored values override defaults, but new default keys are added
  return deepMerge(deepClone(DEFAULT_PERSONAL_DETAILS), stored);
}

/**
 * Persists personal details. Also syncs the professional registration expiry
 * date into the 'registration' checklist item automatically.
 */
export async function savePersonalDetails(details) {
  await chrome.storage.local.set({ [KEY_PERSONAL]: details });

  // Keep the 'registration' checklist item in sync so expiry warnings fire automatically
  const regExpiry = details?.professionalRegistration?.expiryDate;
  if (regExpiry) {
    const checklist = await getSponsorshipChecklist();
    const regItem   = checklist.find(i => i.id === 'registration');
    if (regItem && regItem.expiryDate !== regExpiry) {
      regItem.expiryDate = regExpiry;
      await saveSponsorshipChecklist(checklist);
    }
  }
}

// ── Sponsorship Checklist ─────────────────────────────────────────────────────

/**
 * Returns the checklist merged with defaults, preserving any stored user
 * values and adding any new default items added in updates.
 */
export async function getSponsorshipChecklist() {
  const result = await chrome.storage.local.get(KEY_CHECKLIST);
  const stored = result[KEY_CHECKLIST];
  if (!stored || !Array.isArray(stored)) return DEFAULT_CHECKLIST.map(deepClone);

  return DEFAULT_CHECKLIST.map(defaultItem => {
    const storedItem = stored.find(s => s.id === defaultItem.id);
    return storedItem
      ? Object.assign(deepClone(defaultItem), storedItem)
      : deepClone(defaultItem);
  });
}

/** Persists the full checklist array. */
export async function saveSponsorshipChecklist(checklist) {
  await chrome.storage.local.set({ [KEY_CHECKLIST]: checklist });
}

// ── Sponsorship Readiness API (consumed by Agent 3 and Agent 7) ───────────────

/**
 * Returns a summary of sponsorship document readiness.
 * @returns {{ score: number, ready: Item[], inProgress: Item[], missing: Item[] }}
 *   where Item = { id: string, label: string }
 */
export async function getSponsorshipReadiness() {
  const checklist  = await getSponsorshipChecklist();
  const ready      = checklist.filter(i => i.status === 'Have it');
  const inProgress = checklist.filter(i => i.status === 'In progress');
  const missing    = checklist.filter(i => i.status === 'Missing');

  const score = Math.round((ready.length / checklist.length) * 100);

  const toItem = i => ({ id: i.id, label: i.label });
  return {
    score,
    ready:      ready.map(toItem),
    inProgress: inProgress.map(toItem),
    missing:    missing.map(toItem)
  };
}

// ── Expiry Warnings (consumed by Agent 5 settings UI) ────────────────────────

const DAY_MS     = 86_400_000;
const DAYS_90    = 90  * DAY_MS;
const DAYS_60    = 60  * DAY_MS;
const DAYS_180   = 180 * DAY_MS;

/**
 * Scans all stored dates and returns warning objects for anything expiring
 * within its threshold window, or already expired.
 *
 * @returns {Array<{ field: string, message: string, severity: 'error'|'warning' }>}
 */
export async function getExpiryWarnings() {
  const [details, checklist] = await Promise.all([
    getPersonalDetails(),
    getSponsorshipChecklist()
  ]);
  const warnings = [];
  const now      = Date.now();

  function checkDate(field, iso, threshold, label) {
    if (!iso) return;
    const expiry = Date.parse(iso);
    if (isNaN(expiry)) return;
    const diff = expiry - now;
    if (diff < 0) {
      warnings.push({ field, message: `${label} has expired.`, severity: 'error' });
    } else if (diff < threshold) {
      const dateStr = new Date(expiry).toLocaleDateString('en-GB');
      warnings.push({ field, message: `${label} expires on ${dateStr}.`, severity: 'warning' });
    }
  }

  checkDate('Visa', details.rightToWork?.visaExpiryDate, DAYS_90,
    'Your visa');
  checkDate('Professional Registration', details.professionalRegistration?.expiryDate, DAYS_60,
    'Your professional registration');

  for (const item of checklist) {
    if (item.expiryDate) {
      checkDate(item.label, item.expiryDate, DAYS_180, item.label);
    }
  }

  return warnings;
}

// ── NI Masking ────────────────────────────────────────────────────────────────

/**
 * Returns a masked NI number for display, leaving only the last character
 * visible. Example: "AB 12 34 56 C" → "** ** ** ** C"
 */
export function maskNI(ni) {
  if (!ni || typeof ni !== 'string') return '';
  const trimmed = ni.trim();
  if (trimmed.length === 0) return '';
  // Keep last non-space character; mask everything else
  const chars = trimmed.split('');
  let lastVisible = -1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== ' ') { lastVisible = i; break; }
  }
  return chars.map((c, i) => {
    if (i === lastVisible) return c;
    if (c === ' ') return ' ';
    return '*';
  }).join('');
}

// ── Backup / Restore helpers (consumed by utils/backup_restore.js) ────────────

/** Returns all personal vault data in a single object for backup. */
export async function exportVaultData() {
  const [details, checklist] = await Promise.all([
    getPersonalDetails(),
    getSponsorshipChecklist()
  ]);
  return { personalDetails: details, sponsorshipChecklist: checklist };
}

/** Restores personal vault data from a backup object. */
export async function importVaultData({ personalDetails, sponsorshipChecklist }) {
  const ops = [];
  if (personalDetails)     ops.push(savePersonalDetails(personalDetails));
  if (sponsorshipChecklist) ops.push(saveSponsorshipChecklist(sponsorshipChecklist));
  await Promise.all(ops);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      key in target &&
      typeof target[key] === 'object'
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
