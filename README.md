# JobMatch AI — Chrome Extension

A 9-agent AI-powered Chrome Extension for the UK job market. It matches your CV against job listings, checks Skilled Worker visa sponsorship eligibility, fills NHS application forms, and tracks your applications — all from your browser.

Built entirely with [Claude Code](https://claude.ai/code) using an agentic architecture where each agent has a strict, single responsibility.

> **Status:** Active development. Form filling is functional but not yet fully tested across all supported sites.

---

## What it does

| Tab | Feature |
|---|---|
| **Job Analysis** | Extracts job details from the current page, scores your CV against the job description (0–100), shows full matches, partial matches, and gaps, then optimises your CV without fabricating data |
| **Form Fill** | Scans the current application form, generates answers from your CV using STAR or narrative format, lets you review and edit before injecting into the page |
| **Strategist** | Ingests the full Job Description / Person Specification (+ an optional tailored CV) and maps your real CV evidence to every essential and desirable criterion (met/partial/gap), with keywords and positioning |
| **Sponsorship** | Checks whether the employer is on the UK Register of Licensed Sponsors — via page text, a local register cache, and an agentic Claude search of gov.uk as a fallback |
| **Tracker** | Records all applications with stage, score, deadline, and sponsorship verdict. Analytics dashboard, deadline notifications, and Excel export |

---

## Architecture — 10 specialised agents

Each agent owns exactly one domain. No agent calls another agent's internals.

```
popup.js (UI Orchestrator — routing only, no business logic)
├── Agent 1 · CV Engine          cv_engine.js
│     CV parsing, scoring, ATS-optimised rewrite, cover letter, supporting statement
├── Agent 2 · Form Filler        form_filler.js
│     Field detection, STAR/narrative answer generation, form injection
├── Agent 3 · Sponsorship        sponsorship.js
│     3-tier check: page regex → register cache → Claude agentic gov.uk search
├── Agent 4 · Site Registry      site_registry.js
│     Known site detection, custom site management, job alert monitoring
├── Agent 5 · Personal Vault     personal_vault.js
│     NMC/HCPC pin, NI number, referees, visa status, diversity preferences
├── Agent 6 · Job Tracker        job_tracker.js
│     Application CRUD, deadline alarms, analytics, Excel export
├── Agent 7 · Advisor            advisor.js
│     Post-analysis suggestions, sponsorship prep advice, goal tracking
├── Agent 8 · Interview Prep     interview_prep.js
│     STAR Q&A generation, weak-point identification, study resources
├── Agent 10 · Application Strategist  application_strategist.js
│     Job-document ingestion, CV-to-criteria alignment brief (met/partial/gap)
└── Service Worker               background/service_worker.js
      PROXY_FETCH (CSP-safe gov.uk fetching), alarm handling, message routing
```

*(Agent 9 is the UI Orchestrator — `popup.js` — shown at the top of the tree.)*

---

## Supported job sites

| Site | Job extraction | Form fill |
|---|---|---|
| NHS Jobs (jobs.nhs.uk) | Yes | Yes |
| NHS Jobs (nhsjobs.com) | Yes | Yes |
| TRAC Jobs | Yes | Yes |
| LinkedIn Jobs | Yes | Yes |
| Indeed UK | Yes | Yes |
| Reed | Yes | Yes |
| Total Jobs | Yes | Yes |
| CV-Library | Yes | Yes |
| Find a Job (DWP) | Yes | — |
| Unknown sites | Badge prompt to add | — |

Custom sites can be added from the Settings panel.

---

## CV optimisation — ATS + STAR

The CV optimiser follows ATS compatibility rules by default:

- Standard section headings (`Professional Summary`, `Work Experience`, `Education`, `Skills`, `Certifications`)
- Critical JD keywords placed in the professional summary and the opening line of each role
- No tables, columns, or special characters that ATS parsers cannot read
- Numeric achievements quantified wherever the original CV contains figures

**Format picker** — choose before generating:

| Option | Behaviour |
|---|---|
| Auto | Claude picks based on the role — STAR for NHS/public sector, Standard for commercial |
| Standard | Achievement-led bullets with strong action verbs |
| STAR | Each bullet covers Situation → Task → Action → Result |

The same format picker applies to form fill answers.

The original CV is **never overwritten** — every optimised version is saved as a new labelled copy.

---

## Sponsorship check — 3-tier approach

1. **Tier 1 — Page text regex:** looks for explicit sponsorship statements on the listing page
2. **Tier 2 — Local register cache:** checks a locally cached copy of the UK Register of Licensed Sponsors (CSV, ~500 KB) against the extracted employer name
3. **Tier 3 — Claude agentic search:** if the employer is not found, Claude runs up to 6 turns of `search_gov_uk` / `fetch_gov_uk_page` tool calls to locate the employer on gov.uk

All gov.uk fetches are routed through the service worker (`PROXY_FETCH`) to avoid CSP violations in the popup context.

A manual employer name input is available as a fallback when extraction fails (e.g. aggregator sites where the listed organisation is the platform, not the employer).

---

## Stack

| Layer | Technology |
|---|---|
| Extension | Chrome Manifest V3, vanilla JS ES modules |
| AI | Anthropic Claude API (`claude-sonnet-4-6`) |
| Storage | `chrome.storage.local` |
| PDF parsing | pdf.js |
| DOCX parsing | mammoth.js |
| Excel export | SheetJS (xlsx) |
| Notifications | `chrome.alarms` |

---

## Setup

### Prerequisites
- Google Chrome (or Chromium-based browser)
- An [Anthropic API key](https://console.anthropic.com/)

### Install the extension (developer mode)

```bash
# 1. Clone the repo
git clone https://github.com/Gibexz/jobmatch-ai-browser-extension.git
cd jobmatch-ai-browser-extension

# 2. Install build dependencies and download library files
npm install
npm run libs      # downloads pdf.js, mammoth.js, SheetJS into extension/lib/

# 3. Load into Chrome
# Open chrome://extensions → Enable "Developer mode" → "Load unpacked" → select the /extension folder
```

### Configure
1. Click the JobMatch AI icon in your toolbar
2. Open **Settings (⚙)**
3. Paste your Anthropic API key
4. Upload your CV (PDF, DOCX, or plain text)
5. Fill in your personal details (name, visa status, referees, etc.)

---

## Security

- The API key is stored in `chrome.storage.local` only — it is never written to source code, never logged, and never sent anywhere other than `api.anthropic.com`
- The extension signing key (`.pem`) is excluded from this repository via `.gitignore`
- `extension/lib/` (minified third-party libraries) is excluded — rebuild with `npm run libs`

---

## CI — Automated PR review

Every pull request triggers a Claude-powered review via GitHub Actions ([`.github/workflows/pr-review.yml`](.github/workflows/pr-review.yml)).

The review checks for:
- API key exposure (accidental logging or storage writes)
- `innerHTML` XSS in content scripts
- Agent boundary violations (business logic in `popup.js`, agents calling each other's internals)
- Hard business rules (declaration checkboxes never auto-filled, no fabricated CV data, original CV never overwritten)

Critical issues block the merge. Warnings are informational.

To enable: add your Anthropic API key as a GitHub secret named `ANTHROPIC_API_KEY` in **Settings → Secrets and variables → Actions**.

---

## Contributing

1. Branch from `main`: `git checkout -b feat/your-feature`
2. Make changes — no existing agent scope should be widened without discussion
3. Open a pull request — the AI review runs automatically
4. Address any `STATUS: FAIL` issues before merging

---

## Built with Claude Code

This extension was designed and built entirely through Claude Code — Anthropic's agentic CLI — without writing a single line of code manually. The 9-agent architecture maps directly to the specialised subagents used during development.
