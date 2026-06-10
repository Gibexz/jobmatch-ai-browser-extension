/**
 * Content Script — extract_form.js
 *
 * Runs on all supported job-site pages (document_idle).
 * Responsibilities:
 *   - Scan all visible form fields and extract labels + metadata
 *   - Detect session expiry / logged-out state
 *   - Notify popup of DOM / URL changes (multi-page form support)
 *   - Respond to SCAN_FORM messages from the popup
 */

(function () {
  'use strict';

  // Guard flag prevents double-initialisation if the content script is injected twice
  if (window.__jmFormExtractor) return;
  window.__jmFormExtractor = true;

  // ── Label extraction ─────────────────────────────────────────────────────────

  /**
   * Returns the human-readable label for a form element, using multiple
   * strategies in descending preference order.
   */
  function getLabel(el) {
    // 1. Explicit <label for="id">
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.innerText.trim();
    }

    // 2. Wrapping <label>
    const wrapper = el.closest('label');
    if (wrapper) {
      const text = wrapper.innerText.replace(el.value || '', '').trim();
      if (text) return text;
    }

    // 3. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.innerText?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    // 4. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) return ariaLabel.trim();

    // 5. title attribute
    if (el.title?.trim()) return el.title.trim();

    // 6. <fieldset> legend (useful for radio/checkbox groups)
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) return legend.innerText.trim();
    }

    // 7. Preceding sibling / nearby text element
    const prev = el.previousElementSibling;
    if (prev && /^(label|span|p|div|dt|th|strong|b|h[1-6])$/i.test(prev.tagName)) {
      const t = prev.innerText.trim();
      if (t && t.length < 200) return t;
    }

    // 8. Placeholder as last resort
    if (el.placeholder?.trim()) return el.placeholder.trim();

    return el.name || el.id || '';
  }

  // ── NHS-specific field classifiers ───────────────────────────────────────────

  function hasKeyword(label, keywords) {
    const l = label.toLowerCase();
    return keywords.some(k => l.includes(k));
  }

  function isDeclarationField(el, label) {
    return (
      el.type === 'checkbox' &&
      hasKeyword(label, ['declaration', 'confirm', 'agree', 'consent', 'acknowledge', 'certify', 'accept'])
    );
  }

  function isNHSValuesQuestion(label) {
    return hasKeyword(label, [
      'nhs values', 'nhs constitution', '6cs', 'six cs',
      'care, compassion', 'commitment to quality',
      'everyone counts', 'improving lives', 'working together',
      'demonstrate nhs', 'show how you'
    ]);
  }

  function isDiversityField(label) {
    return hasKeyword(label, [
      'ethnic', 'ethnicity', 'gender', 'sex ', 'sexual orientation',
      'disability', 'religion', 'belief', 'age group', 'monitoring',
      'equal opportunit', 'diversity', 'characteristic'
    ]);
  }

  function isRegistrationNumberField(label) {
    return hasKeyword(label, [
      'nmc', 'hcpc', 'gmc', 'pin number', 'registration number',
      'professional reg', 'nurse reg', 'gdc number'
    ]);
  }

  function isRefereeField(label) {
    return hasKeyword(label, [
      'referee', 'reference', 'referees'
    ]);
  }

  function isRightToWorkField(label) {
    return hasKeyword(label, [
      'right to work', 'visa', 'work permit', 'immigration', 'nationality',
      'citizen', 'indefinite leave'
    ]);
  }

  // ── Radio button grouping ────────────────────────────────────────────────────

  /**
   * Returns a de-duplicated list of radio button group names on the page.
   */
  function getRadioGroupNames() {
    const names = new Set();
    document.querySelectorAll('input[type="radio"]').forEach(r => {
      if (r.name) names.add(r.name);
    });
    return names;
  }

  // ── Session / login detection ────────────────────────────────────────────────

  function detectSessionExpiry() {
    const url   = location.href.toLowerCase();
    const title = document.title.toLowerCase();
    const body  = document.body?.innerText ?? '';

    const urlLoggedOut  = /login|sign[_-]?in|session[_-]?expir|log[_-]?out|auth\//.test(url);
    const titleLoggedOut = /sign in|log in|session expired/.test(title);
    const bodyLoggedOut  = /session\s*(has\s*)?(expired|timed out)|please\s*(log|sign)\s*in|you\s*(have\s*been|are)\s*(logged|signed)\s*out/i.test(body);
    const loginFormVisible = !!document.querySelector('input[type="password"]:not([hidden])');

    return urlLoggedOut || titleLoggedOut || bodyLoggedOut || loginFormVisible;
  }

  // ── Main scanner ─────────────────────────────────────────────────────────────

  function scanFormFields() {
    if (detectSessionExpiry()) {
      return { sessionExpired: true, fields: [] };
    }

    const SELECTOR = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
      'input:not([type="reset"]):not([type="image"]):not([type="file"])',
      'textarea',
      'select'
    ].join(', ');

    const seenRadioGroups = new Set();
    const fields          = [];

    document.querySelectorAll(SELECTOR).forEach(el => {
      // Skip invisible elements
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.offsetParent === null) return;

      // Collapse radio groups into one logical field
      if (el.type === 'radio') {
        if (seenRadioGroups.has(el.name)) return;
        seenRadioGroups.add(el.name);
      }

      const label = getLabel(el);

      const options = [];
      if (el.tagName === 'SELECT') {
        Array.from(el.options).forEach(o => {
          if (o.value) options.push({ value: o.value, text: o.text.trim() });
        });
      }
      if (el.type === 'radio' && el.name) {
        document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`).forEach(r => {
          const rLabel = getLabel(r) || r.value;
          options.push({ value: r.value, text: rLabel });
        });
      }

      fields.push({
        id:                   el.id     || el.name || '',
        name:                 el.name   || el.id   || '',
        type:                 el.type   || el.tagName.toLowerCase(),
        label,
        placeholder:          el.placeholder || '',
        currentValue:         el.value  || '',
        options,                                     // for select / radio
        required:             el.required || false,
        isDeclaration:        isDeclarationField(el, label),
        isNHSValues:          isNHSValuesQuestion(label),
        isDiversity:          isDiversityField(label),
        isRegistrationNumber: isRegistrationNumberField(label),
        isReferee:            isRefereeField(label),
        isRightToWork:        isRightToWorkField(label)
      });
    });

    return {
      sessionExpired: false,
      fields,
      url:   location.href,
      title: document.title
    };
  }

  // ── Message listener ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCAN_FORM') {
      sendResponse(scanFormFields());
    }
    // Must return false for synchronous response
    return false;
  });

  // ── Multi-page form detection ────────────────────────────────────────────────

  let _lastUrl        = location.href;
  let _lastFieldCount = document.querySelectorAll('input, textarea, select').length;

  const _observer = new MutationObserver(() => {
    const currentUrl        = location.href;
    const currentFieldCount = document.querySelectorAll('input, textarea, select').length;

    const urlChanged   = currentUrl !== _lastUrl;
    const formChanged  = Math.abs(currentFieldCount - _lastFieldCount) > 2; // >2 threshold avoids noise from minor DOM mutations

    if (urlChanged || formChanged) {
      _lastUrl        = currentUrl;
      _lastFieldCount = currentFieldCount;
      chrome.runtime.sendMessage({ type: 'FORM_PAGE_CHANGED', url: currentUrl });
    }
  });

  _observer.observe(document.body, { childList: true, subtree: true });
})();
