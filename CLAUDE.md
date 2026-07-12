# JobMatch AI — Build Instructions

## Project
Chrome Extension (Manifest V3) with 10 specialised subagents.
(Agents 1–9 shipped in v1.0; Agent 10 — Application Strategist — added later.)
All application code lives inside the /extension folder.

## Rules
- Never exceed a subagent's defined scope
- Never fabricate CV data — only use what the user provides
- Always ask user approval before adding any new permission or dependency
- Never auto-check declaration checkboxes on NHS forms
- The original CV is never overwritten — always save as a new labelled version
- If stuck or blocked, report clearly and wait for instruction

## Stack
- Chrome Extension: Manifest V3, vanilla JS
- AI: Anthropic Claude API (claude-sonnet-4-20250514)
- Storage: chrome.storage.local
- PDF parsing: pdf.js
- DOCX parsing: mammoth.js
- Excel export: SheetJS (xlsx)
- Notifications: chrome.alarms

## Build Order
1. Permissions & skills audit — present to user, wait for approval
2. Create all subagent definition files in .claude/agents/
3. Build agents in this order: 9 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
4. Final assembly and testing

## Agent 10 — Application Strategist (post-v1.0 addition)
- Ingests uploaded Job Description / Person Specification documents + an optional tailored CV.
- Extracts essential/desirable criteria, maps real CV evidence to each (met/partial/gap),
  and produces a compact cached "alignment brief" per job.
- Reuses Agent 1 (CV Engine) for parsing/storage; never fills forms; never overwrites the CV.
- Consumed by Agent 2 (Form Filler) via getAlignmentBrief(jobId) when wired (later phase).
