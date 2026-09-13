#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const USER_TYPES = new Set(['product_intent', 'preference', 'credential', 'policy', 'external_side_effect']);

function normalizeQuestion(entry, index) {
  const question = typeof entry === 'string' ? { id: `question-${index + 1}`, text: entry, type: 'unknown' } : { ...entry };
  question.id ??= `question-${index + 1}`;
  question.type ??= 'unknown';
  question.text = String(question.text ?? '').trim();
  return question;
}

function comparisonKey(question) {
  return `${question.type}\u0000${question.text.toLocaleLowerCase().replace(/\s+/g, ' ')}`;
}

export function routeQuestions(questions, availableEvidence = {}) {
  return (questions ?? []).map((entry, index) => {
    const question = normalizeQuestion(entry, index);
    if (question.type === 'local_fact') {
      const evidence = question.evidence_key ? availableEvidence[question.evidence_key] : undefined;
      return evidence === undefined
        ? { ...question, route: 'codex_check', reason: 'requires_live_local_evidence' }
        : { ...question, route: 'codex_answer', reason: 'authorized_evidence_available', answer: evidence };
    }
    if (USER_TYPES.has(question.type)) return { ...question, route: 'user', reason: `requires_${question.type}` };
    return { ...question, route: 'user', reason: 'question_type_requires_human_classification' };
  });
}

export function batchQuestions(questions, availableEvidence = {}) {
  const unique = [];
  const seen = new Set();
  for (const [index, entry] of (questions ?? []).entries()) {
    const question = normalizeQuestion(entry, index);
    if (!question.text) continue;
    const key = comparisonKey(question);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(question);
  }
  const routed = routeQuestions(unique, availableEvidence);
  const userQuestions = routed.filter((question) => question.route === 'user');
  const codexAnswers = routed.filter((question) => question.route === 'codex_answer');
  const codexChecks = routed.filter((question) => question.route === 'codex_check');
  return {
    requires_user: userQuestions.length > 0,
    user_prompt: userQuestions.length > 0
      ? ['请一次性回答下面这些问题：', ...userQuestions.map((question, index) => `${index + 1}. ${question.text}`)].join('\n')
      : null,
    user_questions: userQuestions,
    codex_answers: codexAnswers,
    codex_checks: codexChecks,
    counts: {
      received: (questions ?? []).length,
      unique: unique.length,
      duplicates_removed: (questions ?? []).length - unique.length,
      user: userQuestions.length,
      codex_answer: codexAnswers.length,
      codex_check: codexChecks.length,
    },
  };
}

async function main() {
  const batch = process.argv[2] === 'batch';
  const inputPath = process.argv[batch ? 3 : 2];
  if (!inputPath) throw new Error('usage: question-router.mjs [batch] <input.json>');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  console.log(JSON.stringify(batch ? batchQuestions(input.questions, input.available_evidence) : routeQuestions(input.questions, input.available_evidence), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
