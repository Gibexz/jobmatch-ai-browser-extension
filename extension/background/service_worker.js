/**
 * Background Service Worker — JobMatch AI
 *
 * Handles:
 *   - PAGE_VISITED messages → update extension badge
 *   - chrome.alarms → deadline notifications + job alert checks
 *   - chrome.notifications → click handling (open tracker / job URL)
 *   - Extension install / update → set up recurring alarm
 */

import { isKnownSite, checkJobAlerts, getCustomSites, registerCustomSiteScript }
  from '../agents/site_registry.js';
import { getApplications }             from '../agents/job_tracker.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const ALERT_ALARM_NAME    = 'JOB_ALERT_CHECK';
const ALERT_INTERVAL_MINS = 30;

// ── Install / update ──────────────────────────────────────────────────────────

/**
 * Re-registers content scripts for every custom-added job site.
 *
 * Chrome WIPES all dynamically registered content scripts whenever the extension is
 * reloaded or updated, and never restores them. Without this, each custom site the user
 * added silently stops being scanned after any reload — the site still appears in the
 * registry, so it looks supported while extraction quietly returns nothing.
 */
async function restoreCustomSiteScripts() {
  try {
    const sites = await getCustomSites();
    for (const site of sites) {
      // Duplicate registrations are caught and ignored inside registerCustomSiteScript
      await registerCustomSiteScript(site);
    }
  } catch (err) {
    console.warn('[service_worker] Could not restore custom site scripts:', err?.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Set up the recurring job alert check alarm
  chrome.alarms.create(ALERT_ALARM_NAME, {
    delayInMinutes:  1,              // first check 1 min after install
    periodInMinutes: ALERT_INTERVAL_MINS
  });
  // Reload/update wiped the dynamic registrations — put them back
  restoreCustomSiteScripts();
});

// MV3 service workers can be terminated at any time; recreate the alarm on wake-up if it was cleared.
chrome.runtime.onStartup.addListener(async () => {
  const alarm = await chrome.alarms.get(ALERT_ALARM_NAME);
  if (!alarm) {
    chrome.alarms.create(ALERT_ALARM_NAME, {
      delayInMinutes:  1,
      periodInMinutes: ALERT_INTERVAL_MINS
    });
  }
  restoreCustomSiteScripts();
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PAGE_VISITED') {
    handlePageVisited(msg.url, sender.tab?.id);
    return false;
  }
  if (msg.type === 'FORM_PAGE_CHANGED') {
    chrome.runtime.sendMessage({ type: 'FORM_PAGE_CHANGED', url: msg.url }).catch(() => {});
    return false;
  }

  // Popup asks the SW to scrape the gov.uk publications page for the CSV URL.
  // This avoids the popup's "script-src 'self'" CSP being triggered by gov.uk's
  // Link: preload response headers when fetching HTML from that context.
  if (msg.type === 'FIND_REGISTER_CSV_URL') {
    findRegisterCsvUrl()
      .then(url  => sendResponse({ url }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  // PROXY_FETCH: route all gov.uk / assets CDN fetches through the SW so gov.uk's
  // "Link: preload" response headers never reach the popup's "script-src 'self'"
  // CSP context, which would throw a CSP violation and block the request.
  if (msg.type === 'PROXY_FETCH') {
    proxyFetch(msg.url, msg.headers || {})
      .then(r  => sendResponse(r))
      .catch(e => sendResponse({ error: e.message }));
    return true; // keep channel open for async response
  }

  return false;
});

/**
 * Fetch a URL on behalf of the popup and return the response body text.
 * The service worker has no extension-page CSP, so gov.uk's Link: preload
 * headers do not cause violations here. Only allow-listed domains can be proxied.
 * @param {string} url
 * @param {object} [headers]
 * @returns {Promise<{text: string}>}
 */
const PROXY_ALLOWED = [
  'https://www.gov.uk/',
  'https://assets.publishing.service.gov.uk/'
];

async function proxyFetch(url, headers = {}) {
  if (!url || !PROXY_ALLOWED.some(p => url.startsWith(p))) {
    throw new Error(`Proxy not allowed for URL: ${url}`);
  }
  const res  = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = await res.text();
  return { text };
}

/**
 * Fetches the gov.uk publications page and extracts the CSV download URL.
 * Runs in the service-worker context — no popup CSP applies here.
 */
async function findRegisterCsvUrl() {
  const res = await fetch(
    'https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers'
  );
  if (!res.ok) throw new Error(`gov.uk page returned ${res.status}`);
  const html = await res.text();
  const m    = html.match(
    /href="(https:\/\/assets\.publishing\.service\.gov\.uk[^"]+\.csv[^"]*)"/i
  );
  if (m) return m[1];
  throw new Error('CSV link not found on gov.uk publications page');
}

async function handlePageVisited(url, tabId) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;

  try {
    const known = await isKnownSite(url);

    if (!known) {
      // Show "?" badge on the specific tab
      if (tabId) {
        chrome.action.setBadgeText({ text: '?', tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#768692', tabId });
      }
    } else {
      // Clear badge for known sites
      if (tabId) {
        chrome.action.setBadgeText({ text: '', tabId });
      }
    }
  } catch (_) {}
}

// ── Alarm handler ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async alarm => {

  // ── Job alert check ──────────────────────────────────────────────────────
  if (alarm.name === ALERT_ALARM_NAME) {
    try {
      await checkJobAlerts();
    } catch (err) {
      console.warn('[JobMatch SW] Job alert check failed:', err.message);
    }
    return;
  }

  // ── Application deadline notification ────────────────────────────────────
  if (alarm.name.startsWith('deadline-')) {
    const appId = alarm.name.slice('deadline-'.length);
    try {
      const apps = await getApplications();
      const app  = apps.find(a => a.id === appId);
      if (!app) return;

      // Only notify if still in an open stage
      if (['Applied', 'Shortlisted'].includes(app.stage)) {
        chrome.notifications.create(`deadline-notif-${appId}`, {
          type:     'basic',
          iconUrl:  chrome.runtime.getURL('icons/icon48.png'),
          title:    '⏰ Application Deadline Tomorrow',
          message:  `${app.jobTitle} at ${app.companyName}`,
          buttons:  [{ title: 'Open Tracker' }],
          priority: 2,
          requireInteraction: true
        });

        // Store appId for the click handler
        chrome.storage.session.set({ [`notif-deadline-${appId}`]: appId }).catch(() => {});
      }
    } catch (err) {
      console.warn('[JobMatch SW] Deadline notification failed:', err.message);
    }
  }
});

// ── Notification click handler ────────────────────────────────────────────────

chrome.notifications.onClicked.addListener(async notifId => {
  chrome.notifications.clear(notifId);

  if (notifId.startsWith('deadline-notif-')) {
    // Open the popup on the Tracker tab
    // (Cannot open popup programmatically in MV3; open the tracker as a settings page)
    chrome.tabs.create({
      url: chrome.runtime.getURL('settings/settings.html#tracker-redirect')
    });
  }

  if (notifId.startsWith('alert-')) {
    // Open the job listing URL stored in session
    const key = `notif-${notifId.slice('alert-'.length)}`;
    const r   = await chrome.storage.session.get(key).catch(() => ({}));
    const url = r[key];
    if (url) chrome.tabs.create({ url });
  }
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  chrome.notifications.clear(notifId);
  if (notifId.startsWith('deadline-notif-') && btnIdx === 0) {
    chrome.action.openPopup?.().catch(() =>
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') })
    );
  }
});
