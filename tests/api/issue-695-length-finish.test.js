// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/api/issue-695-length-finish.test.js
// A generation cut at the gateway's output cap comes back with
// finish_reason 'length'. The loop treated every non-tool_calls finish as a
// considered final answer, so a truncated generation (often carrying an
// unusable partial tool call) ended the turn silently: half a sentence
// presented as the assistant's answer, no capped flag, no resume path
// (#695). A 'length' finish must end the turn the way a round-capped turn
// does: progress kept, stop explained, `capped: true` for the client.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createSandbox, cleanupSandbox, spawnServer, req } = require('../helpers/sandbox');

function makeCard(id) {
  return {
    $schema: 'klebb.datafile.v1',
    meta: { id, label: id, emoji: '.', view: { enabled: true, component: 'generic-card' } },
    description: id,
    data: [],
  };
}

// Serves queued completion payloads in order; an empty queue answers with a
// clean stop so a runaway loop fails an assertion instead of hanging.
function startSequenceGateway() {
  let queue = [];
  let hits = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      hits += 1;
      const payload = queue.length
        ? queue.shift()
        : { choices: [{ finish_reason: 'stop', message: { content: 'queue exhausted' } }] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        get hits() { return hits; },
        reset(next) { hits = 0; queue = [...next]; },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

const lengthFinish = (content, { partialTool = false } = {}) => ({
  choices: [{
    finish_reason: 'length',
    message: {
      content,
      ...(partialTool ? {
        tool_calls: [{
          id: 'call_cut',
          type: 'function',
          function: { name: 'create_manifest', arguments: '{"manifest":{"meta":{"id":"slee' },
        }],
      } : {}),
    },
  }],
});

const toolRound = (n) => ({
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      content: '',
      tool_calls: [{ id: `call_${n}`, type: 'function', function: { name: 'list_manifests', arguments: '{}' } }],
    },
  }],
});

describe('#695 a length-truncated generation ends the turn as capped', () => {
  let gateway;
  before(async () => { gateway = await startSequenceGateway(); });
  after(async () => { if (gateway) await gateway.close(); });

  async function withChatServer(fn) {
    const sandbox = createSandbox({ seed: { 'w.json': makeCard('w') } });
    const server = await spawnServer(sandbox, {
      CHAT_ENDPOINT_URL: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
      CHAT_API_KEY: 'k',
      CHAT_MODEL: 'm',
    });
    try {
      return await fn(server);
    } finally {
      await server.kill();
      cleanupSandbox(sandbox);
    }
  }

  const ask = (server) => req(server.baseUrl, '/api/chat', {
    method: 'POST', body: { messages: [{ role: 'user', content: 'set up my cards' }] },
  });

  test('a truncated generation with a partial tool call is capped, and the tool is not dispatched', async () => {
    gateway.reset([lengthFinish('Creating your sleep card with', { partialTool: true })]);
    await withChatServer(async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200, 'truncation is a reply, not an error status');
      assert.equal(res.json?.capped, true, 'the client needs the machine-readable resume flag');
      assert.match(res.json?.reply || '', /^Creating your sleep card with/,
        'partial prose is progress and must be kept');
      assert.match(res.json?.reply || '', /keep going/i,
        'the user must learn they can resume');
      assert.match(res.json?.reply || '', /size limit/i,
        'the stated cause must be the output cap');
      assert.doesNotMatch(res.json?.reply || '', /steps/i,
        'a size limit is not the step budget; naming the wrong cause sends the user to the wrong workaround');
      assert.equal(gateway.hits, 1,
        'a truncated tool call is unusable and must not be dispatched or retried');
    });
  });

  test('a truncation after real tool work keeps the progress and the resume path', async () => {
    gateway.reset([toolRound(1), lengthFinish('Made the first card.')]);
    await withChatServer(async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      assert.equal(res.json?.capped, true);
      assert.match(res.json?.reply || '', /^Made the first card\./);
      assert.match(res.json?.reply || '', /keep going/i);
      assert.equal(gateway.hits, 2);
    });
  });

  // The whole output budget can go on a tool call that is then cut
  // mid-arguments, leaving no prose. This must not borrow the round-cap
  // fallback: that one says "ran out of steps", which is a different cause
  // with a different user workaround (narrow the request vs just resume).
  test('a truncation with no prose blames the size limit, not the step budget', async () => {
    gateway.reset([lengthFinish('')]);
    await withChatServer(async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      assert.equal(res.json?.capped, true);
      assert.match(res.json?.reply || '', /keep going/i);
      assert.match(res.json?.reply || '', /ran out of room/i,
        'an empty truncation still owes the user a reason');
      assert.doesNotMatch(res.json?.reply || '', /steps/i,
        'the round-cap fallback names the wrong cause here');
    });
  });

  // Only the deployed gateway spells the output cap 'length'. Any
  // OpenAI-compatible gateway can be configured here, and they variously send
  // 'max_tokens', 'MAX_TOKENS' or 'model_length' for the same condition, plus
  // 'content_filter' for a safety cut. All are fragments, so the rule is "not
  // a clean stop" rather than a list of spellings that goes stale in silence.
  for (const finish of ['content_filter', 'max_tokens', 'MAX_TOKENS', 'model_length']) {
    test(`a '${finish}' finish ends the turn as capped, not as an answer`, async () => {
      gateway.reset([{
        choices: [{ finish_reason: finish, message: { content: 'Halfway through the' } }],
      }]);
      await withChatServer(async (server) => {
        const res = await ask(server);
        assert.equal(res.status, 200);
        assert.equal(res.json?.capped, true,
          `a '${finish}' finish is a fragment and must carry the resume flag`);
        assert.match(res.json?.reply || '', /^Halfway through the/, 'partial prose is progress');
        assert.match(res.json?.reply || '', /keep going/i);
        assert.doesNotMatch(res.json?.reply || '', /steps/i,
          'the step budget was not the cause here');
      });
    });
  }

  // Some gateways simply never send finish_reason. Treating that as a cut would
  // brand every ordinary reply from such a gateway as truncated, so an absent
  // value has to stay a clean answer.
  test('an absent finish_reason is still a clean reply', async () => {
    gateway.reset([{ choices: [{ message: { content: 'no finish reason here' } }] }]);
    await withChatServer(async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      assert.equal(res.json?.reply, 'no finish reason here');
      assert.equal(res.json?.capped, undefined,
        'a missing finish_reason is a quirk of the gateway, not a truncation');
    });
  });

  test('a clean stop finish is unaffected', async () => {
    gateway.reset([toolRound(1), { choices: [{ finish_reason: 'stop', message: { content: 'all done' } }] }]);
    await withChatServer(async (server) => {
      const res = await ask(server);
      assert.equal(res.status, 200);
      assert.equal(res.json?.reply, 'all done');
      assert.equal(res.json?.capped, undefined, 'a completed turn is not capped');
    });
  });
});
