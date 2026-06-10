/**
 * Content Script — fill_form.js
 *
 * Runs on all supported job-site pages (document_idle).
 * Listens for FILL_FORM messages from the popup and injects
 * approved answers into the matching form fields.
 *
 * Declaration checkboxes are NEVER auto-checked — those fields
 * are returned with filled: false so the popup can flag them.
 */

(function () {
  'use strict';

  // Guard flag prevents double-initialisation if the content script is injected twice
  if (window.__jmFormFiller) return;
  window.__jmFormFiller = true;

  // ── Field lookup ─────────────────────────────────────────────────────────────

  /**
   * Finds a form element by id, name, or aria-label.
   * Tries multiple selectors so fields without IDs are still matched.
   */
  function findField(fieldId, fieldName, fieldType) {
    const strategies = [];

    if (fieldId) {
      strategies.push(
        () => document.getElementById(fieldId),
        () => document.querySelector(`[id="${CSS.escape(fieldId)}"]`)
      );
    }
    if (fieldName) {
      strategies.push(
        () => document.querySelector(`[name="${CSS.escape(fieldName)}"]`),
        () => document.querySelector(`[name="${CSS.escape(fieldId)}"]`)
      );
    }
    // For radio groups, any radio with matching name will do — we handle all of them below
    if (fieldType === 'radio' && fieldName) {
      strategies.push(() => document.querySelector(`input[type="radio"][name="${CSS.escape(fieldName)}"]`));
    }

    for (const s of strategies) {
      try { const el = s(); if (el) return el; } catch (_) {}
    }
    return null;
  }

  // ── Dispatch synthetic events ────────────────────────────────────────────────

  /**
   * Fires input + change events so React, Angular, and Vue detect the programmatic change.
   * The native value setter hack is required for React-controlled inputs whose synthetic
   * event system does not fire when el.value is set directly.
   */
  function triggerEvents(el) {
    el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    // Set via the native prototype setter so React's internal fibre sees the update
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeInputValueSetter && el instanceof HTMLInputElement) {
      nativeInputValueSetter.call(el, el.value);
    }
  }

  // ── Per-field fill logic ─────────────────────────────────────────────────────

  function fillTextField(el, value) {
    el.focus();
    el.value = value;
    triggerEvents(el);
    el.blur();
    return true;
  }

  function fillSelect(el, value) {
    // Match by value first, then by text (case-insensitive)
    const lv = value.toLowerCase().trim();

    let matched = Array.from(el.options).find(o => o.value === value);
    if (!matched) matched = Array.from(el.options).find(o => o.text.toLowerCase().trim() === lv);
    if (!matched) matched = Array.from(el.options).find(o => o.text.toLowerCase().includes(lv));

    if (matched) {
      el.value = matched.value;
      triggerEvents(el);
      return true;
    }
    return false;
  }

  function fillRadioGroup(fieldName, value) {
    const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(fieldName)}"]`);
    const lv     = value.toLowerCase().trim();
    let filled   = false;

    for (const r of radios) {
      const rLabel = r.labels?.[0]?.innerText?.toLowerCase()?.trim() ?? '';
      if (r.value === value || r.value.toLowerCase() === lv || rLabel === lv || rLabel.includes(lv)) {
        r.checked = true;
        triggerEvents(r);
        filled = true;
        break;
      }
    }
    return filled;
  }

  function fillDate(el, value) {
    // Normalise to YYYY-MM-DD which is what <input type="date"> expects
    let iso = value;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
      // DD/MM/YYYY → YYYY-MM-DD
      const [d, m, y] = value.split('/');
      iso = `${y}-${m}-${d}`;
    } else if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
      const [d, m, y] = value.split('-');
      iso = `${y}-${m}-${d}`;
    }
    el.value = iso;
    triggerEvents(el);
    return true;
  }

  // ── Main FILL_FORM handler ───────────────────────────────────────────────────

  /**
   * Message payload:
   * {
   *   type: 'FILL_FORM',
   *   answers: [
   *     { fieldId, fieldName, fieldType, value }
   *   ]
   * }
   *
   * Returns:
   * {
   *   results: { [fieldId|fieldName]: 'filled' | 'skipped_declaration' | 'not_found' | 'failed' }
   * }
   */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'FILL_FORM') return false;

    const results = {};

    for (const answer of msg.answers) {
      const { fieldId, fieldName, fieldType, value } = answer;
      const key = fieldId || fieldName;

      // Declaration checkboxes are skipped here as well as in the agent — belt-and-braces safety
      if (answer.isDeclaration) {
        results[key] = 'skipped_declaration';
        continue;
      }

      // Don't overwrite an empty field with an empty value
      if (!value && value !== '0') {
        results[key] = 'skipped_empty';
        continue;
      }

      try {
        let ok = false;

        if (fieldType === 'radio') {
          ok = fillRadioGroup(fieldName || fieldId, value);
        } else if (fieldType === 'checkbox') {
          // Non-declaration checkboxes — fill if value is truthy
          const el = findField(fieldId, fieldName, fieldType);
          if (el) {
            el.checked = value === true || value === 'true' || value === '1';
            triggerEvents(el);
            ok = true;
          }
        } else {
          const el = findField(fieldId, fieldName, fieldType);
          if (!el) { results[key] = 'not_found'; continue; }

          if (el.tagName === 'SELECT') {
            ok = fillSelect(el, value);
          } else if (el.type === 'date') {
            ok = fillDate(el, value);
          } else {
            ok = fillTextField(el, value);
          }
        }

        results[key] = ok ? 'filled' : 'not_found';
      } catch (err) {
        console.warn('[JobMatch fill_form] Error filling field', key, err);
        results[key] = 'failed';
      }
    }

    sendResponse({ results });
    return false; // synchronous
  });
})();
