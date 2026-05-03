// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/config-defaults.test.js
// Verify that config/env.js exposes sane defaults for a fresh public install
// and honours env overrides. This is the safety net against any future PR
// re-introducing personal/hardcoded values.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.resolve(REPO_ROOT, 'config') + path.sep;

// The env module reads env vars at require time, so we clear the cache
// between tests and manipulate process.env per scenario.
function freshEnv(overrides = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(CONFIG_DIR)) delete require.cache[key];
  }
  // Nuke any EH_ / HEALTH_ / CHAT_ vars that could leak from the host.
  // We do this BEFORE applying overrides so the overrides alone define truth.
  const strip = Object.keys(process.env).filter(k =>
    k.startsWith('HEALTH_') ||
    k.startsWith('CHAT_GATEWAY_') ||
    k.startsWith('CHAT_ENDPOINT_') ||
    k.startsWith('FISH_AUDIO_') ||
    k === 'CHAT_API_KEY' ||
    k === 'CHAT_MODEL' ||
    k === 'CHAT_AGENT_NAME' ||
    k === 'CHAT_AGENT_EMOJI' ||
    k === 'SESSION_SECRET' ||
    k === 'AGENT_API_TOKEN' ||
    k === 'PORT' ||
    k === 'HOST' ||
    k === 'TZ'
  );
  for (const k of strip) delete process.env[k];
  // Need HEALTH_HOME set so paths.js doesn't blow up — point at /tmp to avoid
  // warnings.
  process.env.HEALTH_HOME = '/tmp/klebb-test-' + Date.now();
  process.env.HEALTH_HOME_WARNED = '1';
  for (const [k, v] of Object.entries(overrides)) {
    process.env[k] = v;
  }
  return require(path.join(REPO_ROOT, 'config', 'env.js'));
}

describe('config/env.js defaults', () => {
  test('CHAT_AGENT_NAME defaults to "Chat"', () => {
    const env = freshEnv();
    assert.equal(env.CHAT_AGENT_NAME, 'Chat');
  });

  test('CHAT_AGENT_EMOJI defaults to "💬"', () => {
    const env = freshEnv();
    assert.equal(env.CHAT_AGENT_EMOJI, '💬');
  });

  test('INSTANCE_NAME defaults to "Klebb"', () => {
    const env = freshEnv();
    assert.equal(env.INSTANCE_NAME, 'Klebb');
  });

  test('WEBAUTHN_RP_ID defaults to "localhost"', () => {
    const env = freshEnv();
    assert.equal(env.WEBAUTHN_RP_ID, 'localhost');
  });

  test('WEBAUTHN_ORIGIN defaults to http://localhost:<PORT>', () => {
    const env = freshEnv();
    assert.ok(env.WEBAUTHN_ORIGIN.startsWith('http://localhost:'));
  });

  test('CHAT_API_KEY defaults to empty string (no leaked prod token)', () => {
    const env = freshEnv();
    assert.equal(env.CHAT_API_KEY, '');
  });

  test('CHAT_ENDPOINT_URL defaults to empty (chat disabled)', () => {
    const env = freshEnv();
    assert.equal(env.CHAT_ENDPOINT_URL, '');
  });

  test('CHAT_MODEL defaults to empty', () => {
    const env = freshEnv();
    assert.equal(env.CHAT_MODEL, '');
  });

  test('CHAT_ENDPOINT_URL env var sets the endpoint verbatim', () => {
    const env = freshEnv({ CHAT_ENDPOINT_URL: 'https://api.example.com/v1/chat/completions' });
    assert.equal(env.CHAT_ENDPOINT_URL, 'https://api.example.com/v1/chat/completions');
  });

  test('legacy CHAT_GATEWAY_HOST + PORT compose into CHAT_ENDPOINT_URL', () => {
    const env = freshEnv({
      CHAT_GATEWAY_HOST: 'gateway.example.com',
      CHAT_GATEWAY_PORT: '8443',
    });
    assert.equal(
      env.CHAT_ENDPOINT_URL,
      'https://gateway.example.com:8443/v1/chat/completions'
    );
  });

  test('legacy CHAT_GATEWAY_HOST=localhost composes with http (TLS auto-off)', () => {
    const env = freshEnv({ CHAT_GATEWAY_HOST: 'localhost', CHAT_GATEWAY_PORT: '8787' });
    assert.equal(env.CHAT_ENDPOINT_URL, 'http://localhost:8787/v1/chat/completions');
  });

  test('legacy CHAT_GATEWAY_TLS=false forces http even on a remote host', () => {
    const env = freshEnv({
      CHAT_GATEWAY_HOST: 'gateway.example.com',
      CHAT_GATEWAY_PORT: '8787',
      CHAT_GATEWAY_TLS: 'false',
    });
    assert.equal(env.CHAT_ENDPOINT_URL, 'http://gateway.example.com:8787/v1/chat/completions');
  });

  test('CHAT_ENDPOINT_URL wins over legacy CHAT_GATEWAY_HOST', () => {
    const env = freshEnv({
      CHAT_ENDPOINT_URL: 'https://new.example.com/v1/chat/completions',
      CHAT_GATEWAY_HOST: 'old.example.com',
    });
    assert.equal(env.CHAT_ENDPOINT_URL, 'https://new.example.com/v1/chat/completions');
  });

  test('legacy CHAT_GATEWAY_TOKEN maps to CHAT_API_KEY', () => {
    const env = freshEnv({ CHAT_GATEWAY_TOKEN: 'legacy-bearer' });
    assert.equal(env.CHAT_API_KEY, 'legacy-bearer');
  });

  test('CHAT_API_KEY wins over legacy CHAT_GATEWAY_TOKEN', () => {
    const env = freshEnv({
      CHAT_API_KEY: 'canonical',
      CHAT_GATEWAY_TOKEN: 'legacy',
    });
    assert.equal(env.CHAT_API_KEY, 'canonical');
  });

  test('legacy CHAT_GATEWAY_MODEL maps to CHAT_MODEL', () => {
    const env = freshEnv({ CHAT_GATEWAY_MODEL: 'legacy-model' });
    assert.equal(env.CHAT_MODEL, 'legacy-model');
  });

  test('PORT defaults to 8080', () => {
    const env = freshEnv();
    assert.equal(env.PORT, 8080);
  });

  test('TZ defaults to UTC', () => {
    const env = freshEnv();
    assert.equal(env.TZ, 'UTC');
  });

  test('no default value references "Axis", "Eddy", "Onyx", or "Chuck"', () => {
    const env = freshEnv();
    const serialised = JSON.stringify({
      CHAT_AGENT_NAME: env.CHAT_AGENT_NAME,
      CHAT_AGENT_EMOJI: env.CHAT_AGENT_EMOJI,
      INSTANCE_NAME: env.INSTANCE_NAME,
      WEBAUTHN_RP_ID: env.WEBAUTHN_RP_ID,
      WEBAUTHN_RP_NAME: env.WEBAUTHN_RP_NAME,
      WEBAUTHN_ORIGIN: env.WEBAUTHN_ORIGIN,
      CHAT_ENDPOINT_URL: env.CHAT_ENDPOINT_URL,
      HEALTH_SYSTEM_PROMPT: env.HEALTH_SYSTEM_PROMPT,
    });
    for (const name of ['Axis', 'Eddy', 'Onyx', 'Chuck']) {
      // Word-boundary match: "Axis" matches but "Oasis" doesn't.
      const re = new RegExp(`\\b${name}\\b`);
      assert.ok(
        !re.test(serialised),
        `Default values contain forbidden identifier "${name}"`
      );
    }
  });

  test('no default path references /home/minecraft or /mnt/nas or ~/axis', () => {
    const env = freshEnv();
    const serialised = JSON.stringify(env);
    for (const forbidden of ['/home/minecraft', '/mnt/nas', '~/axis', '/opt/onyx']) {
      assert.ok(
        !serialised.includes(forbidden),
        `Defaults contain forbidden path "${forbidden}"`
      );
    }
  });

  test('system prompt falls back to built-in default when HEALTH_SYSTEM_PROMPT unset', () => {
    const env = freshEnv();
    assert.ok(env.HEALTH_SYSTEM_PROMPT.length > 100);
    assert.ok(env.HEALTH_SYSTEM_PROMPT.includes('health assistant'));
  });

  test('default system prompt advertises the create/delete endpoints + the full renderer + input surface', () => {
    const env = freshEnv();
    const p = env.HEALTH_SYSTEM_PROMPT;

    // Endpoints (so the agent knows what to call)
    assert.ok(p.includes('POST /api/manifests'), 'should advertise POST /api/manifests');
    assert.ok(p.includes('DELETE /api/manifests/:id'), 'should advertise DELETE /api/manifests/:id');

    // Every built-in renderer name, so the agent picks correctly
    for (const renderer of [
      'generic-card', 'list-card', 'checklist-card', 'schedule-card',
      'schedule-timeline', 'markdown-doc', 'line-chart', 'table-list',
      'adherence-report', 'greeting-banner',
    ]) {
      assert.ok(p.includes(renderer), `prompt should list renderer "${renderer}"`);
    }

    // Schedule shapes
    for (const type of ['daily', 'weekly', 'every_n_days', 'on_off', 'phased', 'as_needed']) {
      assert.ok(p.includes(type), `prompt should mention schedule type "${type}"`);
    }

    // Marker types (so the calendar integration is discoverable)
    for (const marker of ['field-emoji', 'trend-arrow', 'threshold', 'template']) {
      assert.ok(p.includes(marker), `prompt should mention marker type "${marker}"`);
    }

    // Escape-hatch sentinel: agents need to know unknown renderers are OK
    assert.ok(/persist/i.test(p), 'prompt should describe the ad-hoc persistence escape hatch');
  });
});

describe('config/env.js env overrides', () => {
  test('CHAT_AGENT_NAME env var wins over default', () => {
    const env = freshEnv({ CHAT_AGENT_NAME: 'MyBot' });
    assert.equal(env.CHAT_AGENT_NAME, 'MyBot');
  });

  test('HEALTH_RP_ID env var wins over default', () => {
    const env = freshEnv({ HEALTH_RP_ID: 'health.example.com' });
    assert.equal(env.WEBAUTHN_RP_ID, 'health.example.com');
  });

  test('CHAT_API_KEY env var wins over default', () => {
    const env = freshEnv({ CHAT_API_KEY: 'bearer-token-abc' });
    assert.equal(env.CHAT_API_KEY, 'bearer-token-abc');
  });

  test('HEALTH_INSTANCE_NAME env var wins', () => {
    const env = freshEnv({ HEALTH_INSTANCE_NAME: 'Custom Dashboard' });
    assert.equal(env.INSTANCE_NAME, 'Custom Dashboard');
  });

  test('HEALTH_SYSTEM_PROMPT env var wins', () => {
    const env = freshEnv({ HEALTH_SYSTEM_PROMPT: 'You are a pirate.' });
    assert.equal(env.HEALTH_SYSTEM_PROMPT, 'You are a pirate.');
  });

  test('TZ env var wins over default', () => {
    const env = freshEnv({ TZ: 'Australia/Sydney' });
    assert.equal(env.TZ, 'Australia/Sydney');
  });
});
