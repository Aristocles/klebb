// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// voice/fish.js — Node wrapper for Fish Audio's TTS + ASR.
// Uses the HTTPS API directly (no Python dependency).
//
// TTS:  POST https://api.fish.audio/v1/tts       (model header selects backend)
// ASR:  POST https://api.fish.audio/v1/asr       (MessagePack body)
// Wallet: GET https://api.fish.audio/wallet/self/api-credit
//
// Config is pulled from env:
//   FISH_AUDIO_API_KEY        (required; loaded from ~/.env or systemd env)
//   FISH_AUDIO_VOICE_ID       (reference_id for TTS; configure the voice model)
//   FISH_AUDIO_MODEL          (optional override: s2-pro|s2|speech-1.6)
//   FISH_AUDIO_ENABLED        (optional: set to 'false' to hide the mic UI
//                              even when a key is present)
//
// Legacy aliases (supported for existing deploys):
//   FISH_AUDIO_DEFAULT_VOICE  → FISH_AUDIO_VOICE_ID
//   FISH_BACKEND              → FISH_AUDIO_MODEL
//
// Tier policy (based on remaining API credit):
//   credit >= 50%  → s2-pro
//   credit >= 20%  → s2
//   else           → speech-1.6

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_HOST = 'api.fish.audio';
const STARTING_CREDIT_USD = 100; // Fish grants $100 on signup
const TIER_HIGH = 'speech-1.6-model';   // mapped below
const BACKENDS = {
  's2-pro':      { header: 's1',       name: 'speech-s2-pro' },   // Fish maps 'model: speech-1.6' inside request body historically
  's2':          { header: 's1',       name: 'speech-s2' },
  'speech-1.6':  { header: 'speech-1.6', name: 'speech-1.6' },
};

// Load ~/.env if FISH_AUDIO_API_KEY isn't already set (dev convenience).
// Tests can set KLEBB_SKIP_HOME_ENV=1 to disable this auto-load.
function loadHomeEnv() {
  if (process.env.KLEBB_SKIP_HOME_ENV === '1') return;
  // An explicit empty string means "use no key" — respect that.
  if ('FISH_AUDIO_API_KEY' in process.env) return;
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadHomeEnv();

function getApiKey() {
  const k = (process.env.FISH_AUDIO_API_KEY || '').trim();
  if (!k) throw new Error('FISH_AUDIO_API_KEY not set');
  return k;
}

function getDefaultVoice() {
  const v = (process.env.FISH_AUDIO_VOICE_ID || process.env.FISH_AUDIO_DEFAULT_VOICE || '').trim();
  return v;
}

function isEnabled() {
  const flag = (process.env.FISH_AUDIO_ENABLED || '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  return true;
}

// --- Credit tracking ---
let _creditCache = null;   // { checkedAt, creditUSD, tier }
const CREDIT_TTL_MS = 10 * 60 * 1000; // refetch every 10 min

async function fetchCredit() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: '/wallet/self/api-credit',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${getApiKey()}` },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(body);
            resolve(parseFloat(parsed.credit));
          } catch (e) { reject(e); }
        } else {
          reject(new Error(`wallet HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function pickTier(creditUSD) {
  const pct = (creditUSD / STARTING_CREDIT_USD) * 100;
  if (pct >= 50) return 's2-pro';
  if (pct >= 20) return 's2';
  return 'speech-1.6';
}

async function getCurrentBackend() {
  const explicit = process.env.FISH_AUDIO_MODEL || process.env.FISH_BACKEND;
  if (explicit) return explicit;
  const now = Date.now();
  if (!_creditCache || (now - _creditCache.checkedAt) > CREDIT_TTL_MS) {
    try {
      const credit = await fetchCredit();
      _creditCache = { checkedAt: now, creditUSD: credit, tier: pickTier(credit) };
    } catch (e) {
      // Fall back to last known or s2 if we've never cached
      if (!_creditCache) _creditCache = { checkedAt: now, creditUSD: null, tier: 's2' };
    }
  }
  return _creditCache.tier;
}

async function getStatus() {
  let key = '';
  try { key = getApiKey(); } catch { /* no key configured */ }
  const backend = key ? await getCurrentBackend() : null;
  return {
    enabled: !!key && !!getDefaultVoice() && isEnabled(),
    backend,
    creditUSD: _creditCache?.creditUSD ?? null,
    voiceId: getDefaultVoice(),
  };
}

// --- TTS ---
// Returns a Readable stream of audio bytes (mp3 by default).
// The Fish HTTP TTS API is a plain POST with chunked response.
async function ttsStream({ text, voiceId, format = 'mp3' }) {
  if (!text || !text.trim()) throw new Error('text required');
  const referenceId = voiceId || getDefaultVoice();
  if (!referenceId) throw new Error('no voiceId configured');

  const backendId = await getCurrentBackend();
  const modelHeader = backendId; // Fish accepts 's2-pro' / 's2' / 'speech-1.6' as model header in newer API
  const payload = JSON.stringify({
    text,
    reference_id: referenceId,
    format,
    chunk_length: 200,
    latency: 'normal',
    normalize: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: '/v1/tts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'model': modelHeader,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ stream: res, contentType: res.headers['content-type'] || `audio/${format}` });
      } else {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => reject(new Error(`TTS HTTP ${res.statusCode}: ${body}`)));
      }
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Buffered TTS — consumes the whole Fish response into a single Buffer.
// Needed for serving with Content-Length + Range support (required for
// iOS auto-play). Returns { buffer, contentType }.
async function ttsBuffer({ text, voiceId, format = 'mp3' }) {
  const { stream, contentType } = await ttsStream({ text, voiceId, format });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), contentType };
}

// --- ASR ---
// Fish's /v1/asr expects a MessagePack-encoded body: { audio: Buffer, language?, ignore_timestamps? }
// We don't have msgpack in stdlib, so we implement a minimal encoder for this one shape.
// The full spec is at fish.audio docs.
function _msgpackEncode(obj) {
  const parts = [];
  const keys = Object.keys(obj);
  if (keys.length > 15) throw new Error('too many keys');
  // map header (fixmap): 0x80 | count
  parts.push(Buffer.from([0x80 | keys.length]));
  for (const k of keys) {
    parts.push(_mpStr(k));
    const v = obj[k];
    if (v === null || v === undefined) parts.push(Buffer.from([0xc0]));
    else if (Buffer.isBuffer(v)) parts.push(_mpBin(v));
    else if (typeof v === 'string') parts.push(_mpStr(v));
    else if (typeof v === 'boolean') parts.push(Buffer.from([v ? 0xc3 : 0xc2]));
    else if (typeof v === 'number') {
      // assume uint32
      const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(v, 1); parts.push(b);
    } else throw new Error(`unsupported type for key ${k}: ${typeof v}`);
  }
  return Buffer.concat(parts);
}
function _mpStr(s) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= 31) return Buffer.concat([Buffer.from([0xa0 | buf.length]), buf]);
  if (buf.length <= 0xff) return Buffer.concat([Buffer.from([0xd9, buf.length]), buf]);
  if (buf.length <= 0xffff) { const h = Buffer.alloc(3); h[0]=0xda; h.writeUInt16BE(buf.length,1); return Buffer.concat([h, buf]); }
  const h = Buffer.alloc(5); h[0]=0xdb; h.writeUInt32BE(buf.length,1); return Buffer.concat([h, buf]);
}
function _mpBin(buf) {
  if (buf.length <= 0xff) return Buffer.concat([Buffer.from([0xc4, buf.length]), buf]);
  if (buf.length <= 0xffff) { const h = Buffer.alloc(3); h[0]=0xc5; h.writeUInt16BE(buf.length,1); return Buffer.concat([h, buf]); }
  const h = Buffer.alloc(5); h[0]=0xc6; h.writeUInt32BE(buf.length,1); return Buffer.concat([h, buf]);
}

async function asr({ audio, language }) {
  if (!Buffer.isBuffer(audio)) throw new Error('audio must be a Buffer');
  const body = { audio };
  if (language) body.language = language;
  body.ignore_timestamps = true;
  const payload = _msgpackEncode(body);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST,
      path: '/v1/asr',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/msgpack',
        'Content-Length': payload.length,
      },
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(body);
            resolve({ text: parsed.text || '', duration: parsed.duration || null });
          } catch (e) { reject(new Error(`ASR parse failed: ${e.message}; body: ${body.slice(0,200)}`)); }
        } else {
          reject(new Error(`ASR HTTP ${res.statusCode}: ${body.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  getStatus,
  ttsStream,
  ttsBuffer,
  asr,
  getCurrentBackend,
  fetchCredit,
};
