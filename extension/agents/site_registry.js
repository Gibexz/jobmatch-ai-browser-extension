/**
 * Agent 4 — Site Registry & Detection (shared module — used in popup + service worker)
 *
 * Strict responsibility: Managing known job sites and detecting unknown ones.
 * Nothing else.
 *
 * This file is imported as an ES module both by popup.js and service_worker.js.
 *
 * Public API:
 *   isKnownSite(url)         → boolean
 *   getSiteType(url)         → 'listing'|'form'|'both'|null
 *   getAllSites()             → [...builtIn, ...custom]
 *   getCustomSites()         → Array
 *   addCustomSite(site)      → Promise<savedSite>
 *   updateCustomSite(id, d)  → Promise
 *   removeCustomSite(id)     → Promise
 *   registerCustomSiteScript(site)    → Promise (scripting API)
 *   unregisterCustomSiteScript(id)    → Promise (scripting API)
 *
 *   getAlertProfiles()       → Promise<Array>
 *   saveAlertProfile(p)      → Promise<savedProfile>
 *   updateAlertProfile(id,d) → Promise
 *   removeAlertProfile(id)   → Promise
 *
 *   checkJobAlerts()         → Promise (called by service worker on alarm)
 */

// ── Built-in site patterns ────────────────────────────────────────────────────

export const BUILT_IN_SITES = [
  { id: 'nhs-jobs',    name: 'NHS Jobs',        pattern: 'https://www.jobs.nhs.uk/*',           type: 'both',    searchUrl: 'https://www.jobs.nhs.uk/candidate/search/results/?keyword={keywords}&location={location}' },
  { id: 'nhs-jobs-nw', name: 'NHS Jobs',       pattern: 'https://jobs.nhs.uk/*',               type: 'both',    searchUrl: 'https://jobs.nhs.uk/candidate/search/results/?keyword={keywords}&location={location}' },
  { id: 'nhsjobs',     name: 'NHS Jobs (alt)',   pattern: 'https://www.nhsjobs.com/*',            type: 'both',    searchUrl: '' },
  { id: 'trac',        name: 'TRAC Jobs',        pattern: 'https://www.trac.jobs/*',              type: 'both',    searchUrl: 'https://www.trac.jobs/jobs/search?q={keywords}' },
  { id: 'indeed',      name: 'Indeed UK',        pattern: 'https://www.indeed.co.uk/*',           type: 'both',    searchUrl: 'https://www.indeed.co.uk/jobs?q={keywords}&l={location}' },
  { id: 'reed',        name: 'Reed',             pattern: 'https://www.reed.co.uk/*',             type: 'both',    searchUrl: 'https://www.reed.co.uk/jobs/{keywords}-jobs?locationName={location}' },
  { id: 'linkedin',    name: 'LinkedIn Jobs',    pattern: 'https://www.linkedin.com/jobs/*',      type: 'both',    searchUrl: 'https://www.linkedin.com/jobs/search/?keywords={keywords}&location={location}' },
  { id: 'totaljobs',   name: 'Total Jobs',       pattern: 'https://www.totaljobs.com/*',          type: 'both',    searchUrl: 'https://www.totaljobs.com/jobs/{keywords}?locationName={location}' },
  { id: 'cvlibrary',   name: 'CV-Library',        pattern: 'https://www.cv-library.co.uk/*',        type: 'both',    searchUrl: 'https://www.cv-library.co.uk/jobs/{keywords}' },
  { id: 'dwp-faj',     name: 'Find a Job (DWP)',  pattern: 'https://findajob.dwp.gov.uk/*',          type: 'listing', searchUrl: 'https://findajob.dwp.gov.uk/search?q={keywords}&pp=25&sb=rv&sd=down' }
];

// ── Pattern matching ──────────────────────────────────────────────────────────

/**
 * Converts a glob pattern like "https://www.example.com/*" to a RegExp.
 */
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials (not * or ?)
    .replace(/\*/g, '.*')                    // * → .*
    .replace(/\?/g, '.');                    // ? → .
  return new RegExp(`^${escaped}$`);
}

function matchesSite(url, site) {
  try {
    return patternToRegex(site.pattern).test(url);
  } catch (_) {
    return false;
  }
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const KEY_CUSTOM_SITES   = 'customSites';
const KEY_ALERT_PROFILES = 'alertProfiles';
const KEY_SEEN_LISTINGS  = 'seenListings';

// ── Site CRUD ─────────────────────────────────────────────────────────────────

export async function getCustomSites() {
  const r = await chrome.storage.local.get(KEY_CUSTOM_SITES);
  return r[KEY_CUSTOM_SITES] ?? [];
}

async function saveCustomSites(list) {
  await chrome.storage.local.set({ [KEY_CUSTOM_SITES]: list });
}

export async function getAllSites() {
  const custom = await getCustomSites();
  return [...BUILT_IN_SITES, ...custom];
}

export async function addCustomSite({ name, pattern, type }) {
  const list  = await getCustomSites();
  const entry = {
    id:      crypto.randomUUID(),
    name:    name.trim(),
    pattern: pattern.trim(),
    type:    type || 'both',
    custom:  true
  };
  list.push(entry);
  await saveCustomSites(list);
  await registerCustomSiteScript(entry);
  return entry;
}

export async function updateCustomSite(id, data) {
  const list = await getCustomSites();
  const idx  = list.findIndex(s => s.id === id);
  if (idx < 0) throw new Error('Site not found.');
  list[idx] = { ...list[idx], ...data };
  await saveCustomSites(list);
}

export async function removeCustomSite(id) {
  let list = await getCustomSites();
  list = list.filter(s => s.id !== id);
  await saveCustomSites(list);
  await unregisterCustomSiteScript(id);
}

// ── Pattern matching API ──────────────────────────────────────────────────────

export async function isKnownSite(url) {
  const all = await getAllSites();
  return all.some(s => matchesSite(url, s));
}

export async function getSiteType(url) {
  const all   = await getAllSites();
  const match = all.find(s => matchesSite(url, s));
  return match?.type ?? null;
}

/**
 * Returns a brief pattern pre-fill for "add this site" based on the current URL.
 * Example: https://www.foo.co.uk/jobs/123 → https://www.foo.co.uk/*
 */
export function suggestPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return '';
  }
}

// ── Dynamic content script registration ──────────────────────────────────────

/**
 * Registers content scripts for a newly added custom site.
 * Called from popup context (has scripting permission).
 */
export async function registerCustomSiteScript(site) {
  const scripts = [];

  if (site.type === 'listing' || site.type === 'both') {
    scripts.push({
      id:      `extract_job_${site.id}`,
      matches: [site.pattern],
      js:      ['content_scripts/extract_job.js'],
      runAt:   'document_idle'
    });
  }

  if (site.type === 'form' || site.type === 'both') {
    scripts.push(
      {
        id:      `extract_form_${site.id}`,
        matches: [site.pattern],
        js:      ['content_scripts/extract_form.js'],
        runAt:   'document_idle'
      },
      {
        id:      `fill_form_${site.id}`,
        matches: [site.pattern],
        js:      ['content_scripts/fill_form.js'],
        runAt:   'document_idle'
      }
    );
  }

  for (const script of scripts) {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch (err) {
      // Already registered (e.g. after service worker restart) — ignore.
      if (!err.message?.includes('already registered')) console.warn('[site_registry]', err.message);
    }
  }
}

export async function unregisterCustomSiteScript(siteId) {
  const ids = [
    `extract_job_${siteId}`,
    `extract_form_${siteId}`,
    `fill_form_${siteId}`
  ];
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch (_) {
    // Some IDs may not have been registered (type = listing-only, etc.)
  }
}

// ── Job Alert Profiles ────────────────────────────────────────────────────────

export async function getAlertProfiles() {
  const r = await chrome.storage.local.get(KEY_ALERT_PROFILES);
  return r[KEY_ALERT_PROFILES] ?? [];
}

async function saveAlertProfiles(list) {
  await chrome.storage.local.set({ [KEY_ALERT_PROFILES]: list });
}

export async function addAlertProfile({ keywords, location, salaryMin, salaryMax, requireSponsorship }) {
  const list    = await getAlertProfiles();
  const profile = {
    id:                 crypto.randomUUID(),
    keywords:           Array.isArray(keywords) ? keywords : [keywords],
    location:           location || '',
    salaryMin:          salaryMin || null,
    salaryMax:          salaryMax || null,
    requireSponsorship: requireSponsorship || false,
    enabled:            true,
    dateCreated:        new Date().toISOString()
  };
  list.push(profile);
  await saveAlertProfiles(list);
  return profile;
}

export async function updateAlertProfile(id, data) {
  const list = await getAlertProfiles();
  const idx  = list.findIndex(p => p.id === id);
  if (idx < 0) throw new Error('Alert profile not found.');
  list[idx] = { ...list[idx], ...data };
  await saveAlertProfiles(list);
}

export async function removeAlertProfile(id) {
  const list = await getAlertProfiles();
  await saveAlertProfiles(list.filter(p => p.id !== id));
}

// ── Seen listings tracker (prevents duplicate notifications) ─────────────────

async function getSeenListings() {
  const r = await chrome.storage.local.get(KEY_SEEN_LISTINGS);
  return new Set(r[KEY_SEEN_LISTINGS] ?? []);
}

async function markListingsSeen(ids) {
  const seen = await getSeenListings();
  for (const id of ids) seen.add(id);
  // Cap at 5000 entries to prevent unbounded growth
  const arr = [...seen].slice(-5000);
  await chrome.storage.local.set({ [KEY_SEEN_LISTINGS]: arr });
}

// ── Job alert fetch & match ───────────────────────────────────────────────────

/**
 * Builds a search URL for a profile on a given site.
 */
function buildSearchUrl(site, profile) {
  if (!site.searchUrl) return null;
  const keywords = encodeURIComponent(profile.keywords.join(' '));
  const location = encodeURIComponent(profile.location || '');
  return site.searchUrl
    .replace('{keywords}', keywords)
    .replace('{location}', location);
}

/**
 * Extracts job listing links and titles from raw HTML using simple heuristics.
 * Returns array of { id, title, url }.
 */
function extractListingsFromHTML(html, baseUrl) {
  const results = [];
  // Match anchor tags that look like job listings
  const linkRe  = /<a[^>]+href="([^"]+)"[^>]*>([^<]{5,120})<\/a>/gi;
  let m;

  while ((m = linkRe.exec(html)) !== null) {
    const href  = m[1];
    const text  = m[2].replace(/\s+/g, ' ').trim();
    // Filter: link must look like a job detail page (not navigation/search)
    if (
      href.length > 5 &&
      !href.startsWith('#') &&
      !href.startsWith('javascript') &&
      /job|vacancy|role|position|post/i.test(href + text)
    ) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
      const id      = fullUrl.replace(/[^a-z0-9]/gi, '_').slice(-80);
      results.push({ id, title: text, url: fullUrl });
    }
  }
  return results;
}

/**
 * Tests whether a listing matches an alert profile's keywords.
 */
function listingMatchesProfile(listing, profile) {
  const haystack = listing.title.toLowerCase();
  return profile.keywords.every(kw => haystack.includes(kw.toLowerCase()));
}

/**
 * Called by the service worker on each alarm tick.
 * Checks all enabled profiles across all sites with searchUrls and
 * fires notifications for new matching listings.
 */
export async function checkJobAlerts() {
  const [profiles, seen] = await Promise.all([getAlertProfiles(), getSeenListings()]);
  const enabledProfiles  = profiles.filter(p => p.enabled);
  if (!enabledProfiles.length) return;

  const newlySeenIds = [];

  for (const site of BUILT_IN_SITES) {
    if (!site.searchUrl) continue;

    for (const profile of enabledProfiles) {
      const searchUrl = buildSearchUrl(site, profile);
      if (!searchUrl) continue;

      let html;
      try {
        const res = await fetch(searchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 JobMatchAI-alert-check' },
          signal:  AbortSignal.timeout(10000)
        });
        if (!res.ok) continue;
        html = await res.text();
      } catch (_) {
        continue;
      }

      const listings = extractListingsFromHTML(html, searchUrl);

      for (const listing of listings) {
        if (seen.has(listing.id)) continue;             // already notified
        if (!listingMatchesProfile(listing, profile)) continue; // doesn't match

        newlySeenIds.push(listing.id);

        chrome.notifications.create(`alert-${listing.id}`, {
          type:     'basic',
          iconUrl:  chrome.runtime.getURL('icons/icon48.png'),
          title:    `New Match: ${listing.title.slice(0, 60)}`,
          message:  `Found on ${site.name}${profile.location ? ` (${profile.location})` : ''}`,
          buttons:  [{ title: 'Open Job' }],
          priority: 1
        });

        // Store the URL so notification click can open it
        chrome.storage.session.set({ [`notif-${listing.id}`]: listing.url }).catch(() => {});
      }
    }
  }

  if (newlySeenIds.length) {
    await markListingsSeen(newlySeenIds);
  }
}

// ── Backup / Restore ─────────────────────────────────────────────────────────

export async function exportRegistryData() {
  const [custom, profiles] = await Promise.all([getCustomSites(), getAlertProfiles()]);
  return { customSites: custom, alertProfiles: profiles };
}

export async function importRegistryData({ customSites, alertProfiles }) {
  const ops = [];
  if (Array.isArray(customSites))   ops.push(saveCustomSites(customSites));
  if (Array.isArray(alertProfiles)) ops.push(saveAlertProfiles(alertProfiles));
  await Promise.all(ops);
}
