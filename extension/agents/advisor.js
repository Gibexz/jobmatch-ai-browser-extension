/**
 * Agent 7 — Career & Sponsorship Advisor (popup module)
 *
 * Strict responsibility: Proactive advice, gap identification, and application
 * improvement suggestions. Nothing else.
 *
 * Public API:
 *   runAdvisor(jobText, unfillableGaps, signal) → Promise<Suggestion[]>
 *   runSponsorshipAdvisor(verdict, signal)       → Promise<Suggestion[]>
 */

import { callClaude, buildSystemBlocks, parseJSON } from '../utils/claude_api.js';
import { getActiveCV }           from './cv_engine.js';
import { getSponsorshipReadiness } from './personal_vault.js';

// ── System prompt ─────────────────────────────────────────────────────────────

const ADVISOR_INSTRUCTIONS = `\
You are an expert NHS career advisor and UK immigration specialist.
Your job is to give specific, prioritised, actionable advice to help a candidate:
1. Improve their chances of being shortlisted for this role
2. Improve their chance of securing Skilled Worker visa sponsorship

Analyse the candidate's CV and the job description. Use any genuine gaps provided.

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "suggestions": [
    {
      "priority": "High" | "Medium" | "Low",
      "category": "Clinical" | "Certification" | "Experience" | "Sponsorship" | "Application",
      "text": "<specific actionable advice>",
      "detail": "<optional: 1-2 sentences of additional context>"
    }
  ],
  "sponsorshipPrep": [
    {
      "priority": "High" | "Medium" | "Low",
      "text": "<sponsorship-specific action>",
      "detail": "<optional detail>"
    }
  ],
  "salaryAdvisory": "<brief advice on salary vs threshold if borderline, or empty string>"
}

Rules:
- Be specific — name actual certifications, modules, guidelines, or websites
- Prioritise gaps the candidate can realistically close in 1-6 months
- UK English. NHS context where relevant.
- Maximum 8 suggestions total across all categories.`;

// ── Main advisor call ─────────────────────────────────────────────────────────

/**
 * Runs the career advisor analysis after a job match.
 *
 * @param {string}      jobText         - full job description text
 * @param {Array}       unfillableGaps  - gaps from cv_engine that cannot be filled
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{priority, category, text, detail}>>} - combined suggestions
 */
export async function runAdvisor(jobText, unfillableGaps = [], signal) {
  const cv = await getActiveCV();
  if (!cv) return [];

  const gapBlock = unfillableGaps.length
    ? `\n\nGENUINE GAPS (cannot be filled from the CV — candidate needs to address these):\n${unfillableGaps.map(g => `- ${g}`).join('\n')}`
    : '';

  const system = buildSystemBlocks([
    { text: ADVISOR_INSTRUCTIONS, cache: true },
    { text: `CANDIDATE CV:\n\n${cv.text}`, cache: true }
  ]);

  const messages = [{
    role:    'user',
    content: `JOB DESCRIPTION:\n\n${jobText}${gapBlock}\n\nReturn your advice JSON now.`
  }];

  const raw    = await callClaude({ model: 'sonnet', system, messages, maxTokens: 2000, signal });
  const result = parseJSON(raw);

  const all = [
    ...(result.suggestions    || []),
    ...(result.sponsorshipPrep|| []).map(s => ({ ...s, category: 'Sponsorship' }))
  ];

  // Sort: High first, then Medium, then Low
  const order = { High: 0, Medium: 1, Low: 2 };
  all.sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2));

  return all;
}

// ── Sponsorship advisor ───────────────────────────────────────────────────────

const SPONSOR_ADVISOR_INSTRUCTIONS = `\
You are a UK immigration specialist advising a healthcare professional about visa sponsorship preparation.
Given a sponsorship verdict and the candidate's current document readiness, provide specific preparation advice.

Return ONLY valid JSON:
{
  "advice": [
    {
      "priority": "High" | "Medium" | "Low",
      "text": "<specific action>",
      "detail": "<optional detail>"
    }
  ]
}`;

/**
 * Generates targeted sponsorship preparation advice based on the verdict
 * and the user's current document readiness.
 *
 * @param {object}      verdict - from sponsorship.js analyseSponsorship()
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array>}
 */
export async function runSponsorshipAdvisor(verdict, signal) {
  const readiness = await getSponsorshipReadiness();

  const system   = buildSystemBlocks(SPONSOR_ADVISOR_INSTRUCTIONS);
  const messages = [{
    role:    'user',
    content: [
      `SPONSORSHIP VERDICT: ${verdict.status}`,
      `Reasons: ${(verdict.reasons || []).join('; ')}`,
      `Salary vs threshold: ${verdict.salaryMeetsThreshold === true ? 'Meets threshold' : verdict.salaryMeetsThreshold === false ? 'Below threshold' : 'Unknown'}`,
      ``,
      `CANDIDATE DOCUMENT READINESS (${readiness.score}% complete):`,
      `Ready: ${readiness.ready.map(i => i.label).join(', ') || 'None'}`,
      `In progress: ${readiness.inProgress.map(i => i.label).join(', ') || 'None'}`,
      `Missing: ${readiness.missing.map(i => i.label).join(', ') || 'None'}`,
      ``,
      `Provide prioritised preparation advice.`
    ].join('\n')
  }];

  const raw    = await callClaude({ model: 'sonnet', system, messages, maxTokens: 1000, signal });
  const result = parseJSON(raw);
  return result.advice || [];
}

// ── Salary advisory ───────────────────────────────────────────────────────────

/**
 * Returns true if the salary is within £3,000 of the threshold (borderline).
 * @param {number|null} salary
 * @param {number|null} threshold
 */
export function isBorderlineSalary(salary, threshold) {
  if (!salary || !threshold) return false;
  return Math.abs(salary - threshold) <= 3000;
}
