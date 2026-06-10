/**
 * Content Script — extract_job.js
 *
 * Runs on all supported job-site pages (document_idle).
 * Extracts job details (title, company, salary, description) from the page
 * and responds to EXTRACT_JOB messages from the popup.
 */

(function () {
  'use strict';

  if (window.__jmJobExtractor) return;
  window.__jmJobExtractor = true;

  // ── Text utilities ───────────────────────────────────────────────────────────

  function clean(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  function textOf(sel, ctx) {
    return clean((ctx || document).querySelector(sel)?.innerText ?? '');
  }

  function firstOf(selectors, ctx) {
    for (const sel of selectors) {
      const t = textOf(sel, ctx);
      if (t) return t;
    }
    return '';
  }

  // ── JSON-LD structured data helper ──────────────────────────────────────────
  // schema.org/JobPosting is used by most modern job boards (LinkedIn, Indeed,
  // Find a Job / DWP, Reed, etc.) for Google Jobs indexing.  It is far more
  // stable than CSS class names, which change whenever sites redeploy.
  //
  // Confirmed schema from findajob.dwp.gov.uk (live check 2026-06-06):
  //   baseSalary.currency / .minValue / .maxValue   (direct flat fields)
  // LinkedIn/Indeed use nested QuantitativeValue:
  //   baseSalary.value.minValue / .maxValue

  function getFromJsonLD() {
    try {
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try { data = JSON.parse(script.textContent); } catch (_) { continue; }

        // Handle @graph arrays and top-level arrays
        const items = Array.isArray(data) ? data
                    : (data['@graph'] ? data['@graph'] : [data]);
        const job = items.find(it =>
          it?.['@type'] === 'JobPosting' ||
          (Array.isArray(it?.['@type']) && it['@type'].includes('JobPosting'))
        );
        if (!job) continue;

        // Company — can be a plain string OR { name: '...' } Organisation object
        const org     = job.hiringOrganization;
        const company = (typeof org === 'string' ? org : (org?.name ?? '')).trim();

        // baseSalary has two schema.org variants in the wild:
        //   Flat (DWP/Find a Job):  baseSalary.{ minValue, maxValue, currency }
        //   Nested QuantitativeValue (LinkedIn, Indeed): baseSalary.{ currency, value: { minValue, maxValue } }
        let salary = '';
        const sal  = job.baseSalary;
        if (sal) {
          const cur = (sal.currency ?? 'GBP').trim();
          const sym = cur === 'GBP' ? '£' : `${cur} `;
          const val = sal.value ?? {};           // nested QuantitativeValue or {}
          const raw_min = sal.minValue ?? val.minValue ?? val.value;
          const raw_max = sal.maxValue ?? val.maxValue ?? val.value;
          const min     = parseFloat(raw_min);
          const max     = parseFloat(raw_max);
          if (!isNaN(min) && !isNaN(max) && min !== max) {
            salary = `${sym}${Math.round(min).toLocaleString()} – ${sym}${Math.round(max).toLocaleString()} per annum`;
          } else if (!isNaN(min)) {
            salary = `${sym}${Math.round(min).toLocaleString()} per annum`;
          }
        }

        return {
          title:       (job.title ?? '').trim(),
          company,
          salary,
          description: (job.description ?? '').trim(),
          closingDate: (job.validThrough ?? '').slice(0, 10) // ISO date only
        };
      }
    } catch (_) {}
    return null;
  }

  // Aggregator sites (DWP Find a Job, Indeed, etc.) set hiringOrganization to
  // their own platform name instead of the real employer's name. Clearing it
  // forces the sponsorship checker to use manual employer search rather than
  // incorrectly matching "Indeed" or "NHS Jobs" on the Licensed Sponsors register.
  const AGGREGATOR_NAMES = new Set([
    'nhs jobs', 'reed', 'reed.co.uk', 'indeed', 'linkedin',
    'totaljobs', 'cv-library', 'monster', 'jobsite', 'cwjobs',
    'fish4jobs', 'adzuna', 'guardian jobs', 'charityjob', 'jobsgopublic'
  ]);

  // ── Site-specific extractors ─────────────────────────────────────────────────

  function extractNHSJobs() {
    // ── Employer name ─────────────────────────────────────────────────────────
    // Robust multi-strategy extraction; body-text regex is tried first because
    // it survives any DOM structure change regardless of class names used.
    function getEmployerName() {
      const bodyText = document.body?.innerText ?? '';

      // Strategy 0: full-page body text — handles both label formats:
      //   Multi-line:  "Employer name\n  Value"  (NHS Jobs / jobs.nhs.uk)
      //   Inline:      "Employer: Value"          (nhsjobs.com, older sites)
      // Also matches Organisation / Company variants used by other NHS systems.
      const LABEL = /(?:Employer\s*(?:name)?|Organisation(?:\s*name)?|Employing\s+org(?:anisation)?|Company)/i;
      // Multi-line format: label on one line, value on the next
      const mlMatch = bodyText.match(
        new RegExp(LABEL.source + /\s*\n+\s*([^\n]{3,200})/.source, 'i')
      );
      if (mlMatch) return clean(mlMatch[1]);
      // Inline format: "Label: Value" or "Label — Value" on the same line
      const ilMatch = bodyText.match(
        new RegExp(LABEL.source + /\s*[:\-–]\s*([^\n]{3,200})/.source, 'i')
      );
      if (ilMatch) return clean(ilMatch[1]);

      // Strategy 1: NHS Design System summary list
      for (const key of document.querySelectorAll('.nhsuk-summary-list__key')) {
        if (/employer\s*name/i.test(key.textContent)) {
          const val = key.nextElementSibling;
          if (val) return clean(val.textContent);
        }
      }
      // Strategy 2: <dt> / <dd> definition list
      for (const dt of document.querySelectorAll('dt')) {
        if (/employer\s*name/i.test(dt.textContent)) {
          const dd = dt.nextElementSibling;
          if (dd?.tagName === 'DD') return clean(dd.textContent);
        }
      }
      // Strategy 3: table row — <th>Employer name</th><td>…</td>
      for (const th of document.querySelectorAll('th')) {
        if (/employer\s*name/i.test(th.textContent)) {
          const td = th.nextElementSibling;
          if (td?.tagName === 'TD') return clean(td.textContent);
        }
      }
      // Strategy 4: any inline label followed by a sibling value node
      for (const el of document.querySelectorAll('span, p, div, label, strong, b')) {
        if (/^employer\s*(name)?:?\s*$/i.test(el.textContent?.trim()) &&
            el.children.length === 0) {
          const sib = el.nextElementSibling ?? el.parentElement?.nextElementSibling;
          if (sib && sib.textContent.trim().length < 250) return clean(sib.textContent);
        }
      }
      // Strategy 5: known class / attribute names
      return firstOf(['.employer', '.nhsuk-body-m strong', '.organisation-name',
                      '[data-testid="employer"]', '.job-employer', '.employer-name']);
    }

    // ── Salary ────────────────────────────────────────────────────────────────
    function getSalary() {
      const bodyText = document.body?.innerText ?? '';
      // Multi-line: "Salary\n  £X"
      const mlSalary = bodyText.match(
        /(?:Salary|Pay(?:\s*grade)?|Band|Remuneration|Wage)\s*\n+\s*(£[^\n]{2,100})/i
      );
      if (mlSalary) return clean(mlSalary[1]);
      // Inline: "Salary: £X" or "Band: £X"
      const ilSalary = bodyText.match(
        /(?:Salary|Pay(?:\s*grade)?|Band|Remuneration|Wage)\s*[:\-–]\s*(£[^\n]{2,100})/i
      );
      if (ilSalary) return clean(ilSalary[1]);

      for (const key of document.querySelectorAll('.nhsuk-summary-list__key')) {
        if (/salary|pay|band/i.test(key.textContent)) {
          const val = key.nextElementSibling;
          if (val) return clean(val.textContent);
        }
      }
      return firstOf(['.salary', '[data-testid="salary"]', '.nhsuk-body-m:nth-of-type(2)',
                      '.job-salary']);
    }

    // ── Description: capture main body + all supporting sections ─────────────
    // NHS Jobs splits content across multiple containers — grab them all so
    // the "Certificate of Sponsorship" section is always included.
    function getDescription() {
      const parts = [];
      // Primary job description containers
      for (const sel of ['.job-description', '#job-description', '.job-details-content',
                          '.nhsuk-body-s', 'article']) {
        const el = document.querySelector(sel);
        if (el) { parts.push(clean(el.innerText)); break; }
      }
      // Additional detail sections (sponsorship, about employer, etc.)
      document.querySelectorAll(
        'section, .nhsuk-expander, .job-overview, [class*="additional"], [id*="additional"]'
      ).forEach(el => {
        const txt = clean(el.innerText);
        if (txt.length > 50 && !parts.some(p => p.includes(txt.slice(0, 80)))) {
          parts.push(txt);
        }
      });
      return parts.join('\n\n');
    }

    return {
      title:       firstOf(['h1.nhsuk-heading-xl', 'h1.job-title', 'h1', '.job-title']),
      company:     getEmployerName(),
      salary:      getSalary(),
      description: getDescription()
    };
  }

  // ── Find a Job (DWP) — findajob.dwp.gov.uk ──────────────────────────────────
  // Uses JobPosting JSON-LD for all structured data.
  // IMPORTANT: hiringOrganization often shows the SOURCE PLATFORM (e.g. "NHS Jobs")
  // rather than the actual hiring employer, because DWP aggregates from many boards.
  // We detect this and blank the company so the manual employer search is used.
  function extractDWP(ld) {
    const rawCompany = ld?.company ?? '';
    const isAggregator = AGGREGATOR_NAMES.has(rawCompany.toLowerCase().trim());
    return {
      title:       ld?.title       || firstOf(['h1', 'h2']),
      company:     isAggregator ? '' : rawCompany,
      salary:      ld?.salary      || '',
      description: ld?.description || firstOf(['main', '.job-details', 'article'])
    };
  }

  function extractTRAC() {
    return {
      title:   firstOf(['h1.job-title', 'h1', '.vacancy-title']),
      company: firstOf(['.employer-name', '.trust-name', '.organisation']),
      salary:  firstOf(['.salary-range', '.pay-band', '.salary']),
      description: firstOf(['.job-description', '.vacancy-description', '#jdtabs-description'])
    };
  }

  // JSON-LD is the primary source for Indeed too — data-testid attributes can
  // disappear after A/B tests.  JSON-LD is stable (used for Google Jobs indexing).
  function extractIndeed(ld) {
    return {
      title:   ld?.title   || firstOf(['h1[data-testid="jobsearch-JobInfoHeader-title"]',
                                        'h1.jobsearch-JobInfoHeader-title', 'h1']),
      company: ld?.company || firstOf(['[data-testid="inlineHeader-companyName"]',
                                        '.icl-u-xs-mr--xs .icl-u-lg-mr--sm',
                                        '[data-testid="companyName"]']),
      salary:  ld?.salary  || firstOf(['[data-testid="jobsearch-OtherJobDetailsContainer"] [class*="salary"]',
                                        '#salaryInfoAndJobType span', '[class*="salary"]']),
      description: firstOf(['#jobDescriptionText', '.jobsearch-jobDescriptionText'])
                || ld?.description || ''
    };
  }

  function extractReed() {
    return {
      title:   firstOf(['h1[itemprop="title"]', 'h1.job-title', 'h1']),
      company: firstOf(['[itemprop="hiringOrganization"] [itemprop="name"]', '.employer']),
      salary:  firstOf(['.salary', '[itemprop="baseSalary"]', '.detail-item']),
      description: firstOf(['[itemprop="description"]', '.job-description', '#descriptionDetails'])
    };
  }

  // JSON-LD is the primary source for LinkedIn — their CSS class names change
  // every few weeks.  JSON-LD is stable because LinkedIn uses it for Google Jobs.
  function extractLinkedIn(ld) {
    return {
      title:   ld?.title   || firstOf(['h1.job-title', 'h1.t-24',
                                        '.job-details-jobs-unified-top-card__job-title h1', 'h1']),
      company: ld?.company || firstOf(['.job-details-jobs-unified-top-card__company-name a',
                                        '.topcard__org-name-link', '.company-name']),
      salary:  ld?.salary  || firstOf(['.job-details-jobs-unified-top-card__salary-main-rail',
                                        '.compensation__salary', '[class*="salary"]']),
      description: firstOf(['.job-details__description-main-content', '.description__text',
                             '#job-details']) || ld?.description || ''
    };
  }

  function extractTotalJobs() {
    return {
      title:   firstOf(['h1.job-title', 'h1']),
      company: firstOf(['.company', '.employer-name']),
      salary:  firstOf(['.salary', '.pay']),
      description: firstOf(['.job-description', '#job-description'])
    };
  }

  function extractCVLibrary() {
    return {
      title:   firstOf(['h1.job-title', 'h1']),
      company: firstOf(['.company-name', '.employer']),
      salary:  firstOf(['.salary', '.pay-range']),
      description: firstOf(['.job-description', '#job-description'])
    };
  }

  // ── Generic fallback ─────────────────────────────────────────────────────────

  function extractGeneric(ld) {
    // JSON-LD is tried first — any site using schema.org/JobPosting for Google
    // Jobs indexing will have reliable structured data here.
    if (ld?.title && ld?.company) {
      return {
        title:       ld.title,
        company:     ld.company,
        salary:      ld.salary      || '',
        description: ld.description || ''
      };
    }

    // Fall through to DOM heuristics
    const title = ld?.title
               || firstOf(['h1', 'h2'])
               || clean(document.title.split('|')[0].split(' - ')[0]);

    let company = ld?.company || '';
    if (!company) {
      const ogSite = document.querySelector('meta[property="og:site_name"]')?.content;
      if (ogSite) company = clean(ogSite);
    }

    // Salary: look for a leaf element containing a £ sign near a "salary" label
    let salary = ld?.salary || '';
    if (!salary) {
      const salaryEl = [...document.querySelectorAll('*')]
        .find(el => /salary|pay|band|£/i.test(el.innerText) &&
                    el.children.length === 0 &&
                    el.innerText.length < 200);
      if (salaryEl) salary = clean(salaryEl.innerText);
    }

    // Description: longest text block
    const candidates = [...document.querySelectorAll(
      'article, main, [class*="description"], [id*="description"], section'
    )].sort((a, b) => b.innerText.length - a.innerText.length);
    const description = ld?.description
                     || (candidates[0] ? clean(candidates[0].innerText).slice(0, 8000) : '');

    return { title, company, salary, description };
  }

  // ── Sponsorship mention scanner ───────────────────────────────────────────────

  // YES patterns — ordered from most specific to least specific.
  // Each captures a distinct positive sponsorship signal.
  const SPONSOR_YES = [
    // Exact NHS Jobs phrasing: "Skilled Worker sponsorship ... welcome / considered"
    /applications?\s*from.*who\s*require\s*(current\s*)?skilled\s*worker\s*sponsorship.*welcome/i,
    /applications?\s*from.*who\s*(require|need).*skilled\s*worker.*sponsorship.*consider/i,
    /skilled\s*worker\s*sponsorship.*welcome/i,
    /welcome.*skilled\s*worker\s*sponsorship/i,
    // Section headings / standard phrases
    /certificate\s*of\s*sponsorship/i,
    /skilled\s*worker\s*visa/i,
    /skilled\s*worker\s*sponsorship/i,     // Catches the NHS Jobs phrase directly
    /visa\s*sponsorship\s*(is\s*)?(available|offered|provided)/i,
    /we\s*(can|will|do)\s*(offer\s*)?sponsor/i,
    /sponsorship\s*(is\s*)?(offered|provided|available)/i,
    /cos\s*available/i,
    /tier\s*2.*(?:visa|sponsorship)/i,
    /work\s*permit.*available/i,
    /eligible.*skilled\s*worker.*visa/i
  ];

  // NO patterns — only fire for explicit, unambiguous refusals.
  const SPONSOR_NO = [
    /unable\s*to\s*(offer|provide|give)\s*(visa\s*)?sponsorship/i,
    /cannot\s*sponsor/i,
    /can\s*not\s*sponsor/i,
    /does\s*not\s*(offer|provide)\s*sponsorship/i,
    /sponsorship\s*(is\s*)?not\s*(available|offered|provided)/i,
    /no\s*(?:visa\s*)?sponsorship\s*(available|offered|provided)/i,
    /sponsorship\s*will\s*not\s*be\s*(offered|provided)/i,
    // Only triggers if "not" actually precedes "consider" in the same clause
    /applications?\s*from.*who\s*(require|need).*sponsorship.*\bnot\b.*consider/i
  ];

  /**
   * Scan text for sponsorship signals.
   * YES always wins over NO — a page that says sponsorship is welcome but also
   * has standard "cannot sponsor those who need a work permit" boilerplate
   * should still return 'yes'.
   */
  function detectSponsorshipMentions(text) {
    const yesMatches = [];
    const noMatches  = [];

    for (const re of SPONSOR_YES) {
      const m = text.match(re);
      if (m) yesMatches.push(m[0]);
    }
    for (const re of SPONSOR_NO) {
      const m = text.match(re);
      if (m) noMatches.push(m[0]);
    }

    // YES always beats NO: some employers include both "sponsorship available" and
    // "cannot sponsor those who need a work permit" boilerplate on the same page.
    if (yesMatches.length > 0) return { explicit: 'yes', text: yesMatches };
    if (noMatches.length  > 0) return { explicit: 'no',  text: noMatches  };
    return { explicit: null, text: [] };
  }

  // ── Deadline / expiry extraction ─────────────────────────────────────────────

  function extractDates(text) {
    // Match dates in formats: DD/MM/YYYY, D Month YYYY, YYYY-MM-DD
    const patterns = [
      /closing\s*date[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
      /closing\s*date[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i,
      /apply\s*by[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
      /deadline[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
    ];
    const result = {};
    for (const p of patterns) {
      const m = text.match(p);
      if (m && !result.closingDate) result.closingDate = m[1];
    }
    return result;
  }

  // ── Main extractor ───────────────────────────────────────────────────────────

  function extract() {
    const host = location.hostname.replace(/^www\./, '');

    // Parse JSON-LD once — shared by extractors that prefer it (LinkedIn, Indeed,
    // DWP Find a Job, and generic).  NHS Jobs doesn't publish JSON-LD so this
    // returns null for those pages; the NHS-specific extractors are unaffected.
    const ld = getFromJsonLD();

    let raw;
    if (host === 'jobs.nhs.uk' || host === 'nhsjobs.com')   raw = extractNHSJobs();
    else if (host === 'findajob.dwp.gov.uk')                 raw = extractDWP(ld);
    else if (host === 'trac.jobs')                           raw = extractTRAC();
    else if (host === 'indeed.co.uk')                        raw = extractIndeed(ld);
    else if (host === 'reed.co.uk')                          raw = extractReed();
    else if (host === 'linkedin.com')                        raw = extractLinkedIn(ld);
    else if (host === 'totaljobs.com')                       raw = extractTotalJobs();
    else if (host === 'cv-library.co.uk')                    raw = extractCVLibrary();
    else                                                     raw = extractGeneric(ld);

    const descText = raw.description || '';

    // Scan the full page text, not just the description container, because NHS Jobs
    // places the "Certificate of Sponsorship" section outside the main description div.
    const fullPageText = clean(document.body?.innerText ?? '').slice(0, 20000);
    const sponsorText  = [raw.title, raw.company, raw.salary, descText, fullPageText].join(' ');

    const sponsorship = detectSponsorshipMentions(sponsorText);
    const dates       = extractDates(fullPageText);

    // JSON-LD validThrough is a reliable ISO closing date — use it if DOM
    // parsing didn't find one.
    const closingDate = dates.closingDate || ld?.closingDate || '';

    return {
      title:               raw.title   || clean(document.title),
      company:             raw.company || '',
      salary:              raw.salary  || '',
      descriptionText:     descText.slice(0, 8000), // cap at 8 k chars for API calls
      sponsorshipMentions: sponsorship,
      closingDate,
      url:                 location.href
    };
  }

  // ── Message listener ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_JOB') {
      sendResponse(extract());
    }
    return false;
  });
})();
