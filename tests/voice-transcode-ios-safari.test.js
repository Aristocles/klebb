// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/voice-transcode-ios-safari.test.js
//
// Regression test for #319 — iOS Safari MediaRecorder emits fragmented
// MP4 (fMP4) with an empty moov at the start and moof/mdat fragment
// pairs throughout the stream. The moov atom that the demuxer needs is
// written at the end so ffmpeg must be able to seek backward; piping
// via stdin (the pre-fix approach) fails with "Invalid data found when
// processing input". This test synthesises a true fragmented MP4 using
// the same mov flags iOS Safari uses and verifies transcodeToWav
// produces a valid 16kHz mono 16-bit WAV.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { transcodeToWav } = require('../voice/transcode');

// fs.unlink in the transcode cleanup is async (fire-and-forget), so we
// need a brief delay before checking that temp files are gone.
const tick = () => new Promise(r => setTimeout(r, 50));

function ffmpegAvailable() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

const skipIfNoFfmpeg = ffmpegAvailable() ? false : { skip: 'ffmpeg not on PATH' };

describe('transcodeToWav – iOS Safari fragmented MP4 regression (#319)', skipIfNoFfmpeg, () => {
  let fixtureDir;
  let fmp4Buf;

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-ios-safari-fixture-'));
    const fmp4Path = path.join(fixtureDir, 'ios-safari-recording.mp4');

    // Synthesise a fragmented MP4 that mirrors what iOS Safari's
    // MediaRecorder produces: empty moov up front, moof+mdat fragments,
    // moov rewritten at the end of the stream. The flags below match
    // the WebKit MediaRecorder implementation.
    const result = spawnSync('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-t', '1.0',
      '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-y', fmp4Path,
    ]);

    assert.strictEqual(result.status, 0,
      `ffmpeg fixture generation failed: ${result.stderr?.toString()}`);

    fmp4Buf = fs.readFileSync(fmp4Path);
    assert.ok(fmp4Buf.length > 0, 'fixture file should not be empty');
  });

  after(() => {
    if (fixtureDir) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('fixture is actually a fragmented MP4 (contains moof boxes)', () => {
    // A fragmented MP4 must contain at least one 'moof' box (movie
    // fragment header). If this assertion fails, the fixture wasn't
    // generated with the correct flags and the test is meaningless.
    const moofSignature = Buffer.from('moof');
    const hasMoof = fmp4Buf.includes(moofSignature);
    assert.ok(hasMoof, 'expected fragmented MP4 to contain moof atom');
  });

  test('transcodeToWav succeeds on fragmented MP4 from iOS Safari', async () => {
    const wav = await transcodeToWav(fmp4Buf);

    // WAV header validation
    assert.strictEqual(wav.slice(0, 4).toString(), 'RIFF', 'missing RIFF header');
    assert.strictEqual(wav.slice(8, 12).toString(), 'WAVE', 'missing WAVE identifier');
    assert.ok(wav.length > 44, 'output smaller than minimum WAV header');

    // Parse the fmt chunk to verify transcode parameters
    const fmtOffset = wav.indexOf('fmt ');
    assert.ok(fmtOffset !== -1, 'WAV missing fmt chunk');

    const audioFormat = wav.readUInt16LE(fmtOffset + 8);
    const numChannels = wav.readUInt16LE(fmtOffset + 10);
    const sampleRate = wav.readUInt32LE(fmtOffset + 12);
    const bitsPerSample = wav.readUInt16LE(fmtOffset + 22);

    assert.strictEqual(audioFormat, 1, 'expected PCM format (1)');
    assert.strictEqual(numChannels, 1, 'expected mono (1 channel)');
    assert.strictEqual(sampleRate, 16000, 'expected 16000 Hz sample rate');
    assert.strictEqual(bitsPerSample, 16, 'expected 16-bit samples');
  });

  test('no temp files leaked after successful transcode', async () => {
    const tmpDir = os.tmpdir();
    const before = fs.readdirSync(tmpDir).filter(f => f.startsWith('klebb-asr-'));
    await transcodeToWav(fmp4Buf);
    await tick();
    const after = fs.readdirSync(tmpDir).filter(f => f.startsWith('klebb-asr-'));
    assert.strictEqual(after.length, before.length,
      'transcode leaked a temp file in os.tmpdir()');
  });

  test('no temp files leaked after failed transcode', async () => {
    const tmpDir = os.tmpdir();
    const before = fs.readdirSync(tmpDir).filter(f => f.startsWith('klebb-asr-'));
    try {
      await transcodeToWav(Buffer.from('corrupted-not-real-audio'));
    } catch {
      // expected to throw
    }
    await tick();
    const after = fs.readdirSync(tmpDir).filter(f => f.startsWith('klebb-asr-'));
    assert.strictEqual(after.length, before.length,
      'failed transcode leaked a temp file in os.tmpdir()');
  });
});
