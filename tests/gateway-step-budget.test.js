// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/gateway-step-budget.test.js
// The agent loop's per-step timeout is only useful while it stays SOFT: a
// soft trip rejects as gateway_iter_timeout, which runAgentLoop catches and
// turns into a capped turn the user can resume, whereas at or above the
// transport ceiling the same stall rejects as a hard gateway_timeout, escapes
// the loop and costs the whole turn to a 504. Two supported configurations
// send a budget through that is not soft at all: CHAT_ITER_TIMEOUT_MS=0 (the
// documented "no per-step cap"), which leaves the remaining turn deadline as
// the budget, and any CHAT_TURN_DEADLINE_MS above the ceiling (the default is,
// since #694). softStepBudget is what keeps both soft.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { GATEWAY_HARD_TIMEOUT_MS, softStepBudget } = require('../lib/gateway');
const ENV = require('../config/env');

describe('#694 the per-step gateway budget stays under the transport ceiling', () => {
  test('a budget above the ceiling is clamped strictly below it', () => {
    const clamped = softStepBudget(GATEWAY_HARD_TIMEOUT_MS + 60000);
    assert.ok(clamped < GATEWAY_HARD_TIMEOUT_MS,
      `clamped budget ${clamped} must be strictly below the ${GATEWAY_HARD_TIMEOUT_MS}ms ceiling, or the timeout is hard`);
  });

  test('a budget exactly at the ceiling is still clamped', () => {
    // The gateway's soft/hard test is `effectiveTimeout < ceiling`, so equality
    // is the hard branch. An off-by-one here is the whole defect.
    assert.ok(softStepBudget(GATEWAY_HARD_TIMEOUT_MS) < GATEWAY_HARD_TIMEOUT_MS);
  });

  test('a budget already below the ceiling is passed through untouched', () => {
    assert.equal(softStepBudget(1000), 1000);
    assert.equal(softStepBudget(ENV.CHAT_ITER_TIMEOUT_MS), ENV.CHAT_ITER_TIMEOUT_MS,
      'the shipped per-step default must not be shortened by the clamp');
  });

  test('"no cap requested" is preserved, not turned into a cap', () => {
    // 0 means the caller wants no per-step timeout; inventing one here would
    // silently re-cap a config the operator deliberately disabled.
    assert.equal(softStepBudget(0), 0);
    assert.equal(softStepBudget(undefined), undefined);
  });

  test('every shipped default that can become a step budget stays soft', () => {
    // CHAT_ITER_TIMEOUT_MS is the budget when set; the remaining turn deadline
    // is the budget when it is 0. Both reach callGateway, so both must clamp
    // soft, and this fails if a future edit moves any of the three numbers past
    // each other.
    for (const [name, value] of [
      ['CHAT_ITER_TIMEOUT_MS', ENV.CHAT_ITER_TIMEOUT_MS],
      ['CHAT_TURN_DEADLINE_MS', ENV.CHAT_TURN_DEADLINE_MS],
    ]) {
      if (!value) continue;
      assert.ok(softStepBudget(value) < GATEWAY_HARD_TIMEOUT_MS,
        `${name}=${value} must clamp below the ${GATEWAY_HARD_TIMEOUT_MS}ms ceiling to stay soft`);
    }
  });
});
