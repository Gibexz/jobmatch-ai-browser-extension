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

  if (window.__jmDetect) return;
  window.__jmDetect = true;

  // Tell the service worker which URL was just loaded
  chrome.runtime.sendMessage({
    type: 'PAGE_VISITED',
    url:  location.href
  });
})();
