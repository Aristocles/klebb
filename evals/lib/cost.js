// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// evals/lib/cost.js — estimate the model spend of a corpus run so the
// operator sees the number before a cent moves. Pure: no I/O.
//
// The corpus drives the REAL agent against a REAL model, so a full run costs
// real money. The estimate is deliberately conservative (sticker prices, no
// prompt-cache discount): if the gateway caches the identical system prompt +
// tool definitions across calls, the actual bill comes in under this.

// Per-call token profile, measured from real corpus runs (#519): the system
// prompt + 27 tool definitions dominate, so input tokens per call barely move
// with the user message. Output is small. A conversation turn triggers ~2.5
// model calls because the agent loop runs an extra iteration per tool call.
// These are rough — the loop's iteration count varies with what the model
// decides to do — but they matched the measured $96 spend within a few %.
const AVG_CALLS_PER_TURN = 2.5;
const AVG_INPUT_TOKENS_PER_CALL = 34000;
const AVG_OUTPUT_TOKENS_PER_CALL = 200;

// Sticker $/million tokens (OpenRouter passthrough, 2026-07). Add rows as the
// gateway gains models; an unknown model estimates as null → always confirm.
const PRICING = {
  'sonnet-5': { in: 2, out: 10 },
  'sonnet-4.6': { in: 3, out: 15 },
  'sonnet-4.5': { in: 3, out: 15 },
  'sonnet-4': { in: 3, out: 15 },
  'opus-4.7': { in: 5, out: 25 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
};

// Cheapest capable default. Property assertions don't need Opus; reply-quality
// scoring (the judge tier) is where a stronger model earns its cost.
const DEFAULT_MODEL = 'sonnet-5';

// Above this estimated USD, a run must be confirmed (or --yes). Below it
// (single-scenario smokes, 1-rep spot checks) the run proceeds without nagging.
const CONFIRM_THRESHOLD_USD = 0.5;

// Match a pricing row against a model name or full slug, e.g.
// 'anthropic/claude-sonnet-5' or 'claude-sonnet-4.5'. Longest key first so
// 'sonnet-4.5' wins over 'sonnet-4'.
function priceFor(model) {
  const name = String(model || '');
  const key = Object.keys(PRICING)
    .sort((a, b) => b.length - a.length)
    .find(k => name.includes(k));
  return { key: key || null, price: key ? PRICING[key] : null };
}

// Estimate a run over `scenarios` at `reps` repetitions against `model`.
// Returns turns/calls/tokens plus usd (null when the model has no pricing row).
function estimateRun(scenarios, reps, model) {
  const turnsPerRep = scenarios.reduce((n, s) => n + (Array.isArray(s.turns) ? s.turns.length : 0), 0);
  const turns = turnsPerRep * reps;
  const calls = Math.round(turns * AVG_CALLS_PER_TURN);
  const inputTokens = calls * AVG_INPUT_TOKENS_PER_CALL;
  const outputTokens = calls * AVG_OUTPUT_TOKENS_PER_CALL;
  const { key, price } = priceFor(model);
  const usd = price ? (inputTokens * price.in + outputTokens * price.out) / 1e6 : null;
  return { turns, calls, inputTokens, outputTokens, model, priceKey: key, usd };
}

// Should this estimate force a confirmation prompt? Unknown-price runs always
// confirm (can't spend blind); otherwise confirm above the threshold.
function needsConfirm(est) {
  return est.usd === null || est.usd > CONFIRM_THRESHOLD_USD;
}

// One-line human summary for the console.
function formatEstimate(est, { remote = false } = {}) {
  const cost = est.usd === null
    ? `unknown $ (no pricing for "${est.model}")`
    : `~$${est.usd.toFixed(2)}`;
  const modelNote = remote
    ? ` — estimate assumes "${est.model}"; the instance's own model config governs the real bill`
    : '';
  return `estimate: ${est.turns} turns → ~${est.calls} model calls, ~${(est.inputTokens / 1e6).toFixed(1)}M in + ~${(est.outputTokens / 1e3).toFixed(0)}k out tokens, ${cost}${modelNote}`;
}

module.exports = {
  estimateRun,
  needsConfirm,
  formatEstimate,
  priceFor,
  PRICING,
  DEFAULT_MODEL,
  CONFIRM_THRESHOLD_USD,
  AVG_CALLS_PER_TURN,
  AVG_INPUT_TOKENS_PER_CALL,
  AVG_OUTPUT_TOKENS_PER_CALL,
};
