/**
 * Content Script — detect_unknown.js
 *
 * Runs on all URLs (document_idle).
 * Notifies the service worker that the user has navigated to a page,
 * so it can update the extension icon badge (?/clear) accordingly.
 * The service worker holds the site registry and owns badge state.
 */

(function () {
  'use strict';

  // Guard flag prevents duplicate messages on pages where the script is injected more than once
  if (window.__jmDetect) return;
  window.__jmDetect = true;

  // Notify the service worker so it can update the badge for this tab
  chrome.runtime.sendMessage({
    type: 'PAGE_VISITED',
    url:  location.href
  });
})();
