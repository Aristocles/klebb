// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// tests/voice-transcode.test.js
//
// Regression for #319: iOS Safari MediaRecorder produces MP4 with the
// moov atom at the end of the file. ffmpeg can't demux that from
// stdin (not seekable), so transcodeToWav must stage the input on
// disk. We synthesise a tiny MP4 with ffmpeg, hand it to the helper,
// and assert we get back a real WAV.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { transcodeToWav } = require('../voice/transcode');

function ffmpegAvailable() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

const skipIfNoFfmpeg = ffmpegAvailable() ? false : { skip: 'ffmpeg not on PATH' };

describe('transcodeToWav', skipIfNoFfmpeg, () => {
  let mp4Buf;
  let wavBuf;

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klebb-asr-fixture-'));
    const mp4Path = path.join(dir, 'sample.mp4');
    const wavPath = path.join(dir, 'sample.wav');

    // 0.5s of silence as MP4/AAC. Default muxer leaves moov at the end,
    // so this fixture replicates the iOS Safari case that broke pipe:0.
    spawnSync('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
      '-t', '0.5',
      '-c:a', 'aac',
      '-y', mp4Path,
    ]);
    mp4Buf = fs.readFileSync(mp4Path);

    // Same shape as a WAV input: should also round-trip cleanly.
    spawnSync('ffmpeg', [
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
      '-t', '0.5',
      '-c:a', 'pcm_s16le',
      '-y', wavPath,
    ]);
    wavBuf = fs.readFileSync(wavPath);
  });

  test('produces RIFF/WAVE output from MP4 input (the iOS Safari case)', async () => {
    const out = await transcodeToWav(mp4Buf);
    assert.ok(out.length > 44, 'output should be larger than a WAV header');
    assert.equal(out.slice(0, 4).toString(), 'RIFF');
    assert.equal(out.slice(8, 12).toString(), 'WAVE');
  });

  test('produces RIFF/WAVE output from WAV input', async () => {
    const out = await transcodeToWav(wavBuf);
    assert.ok(out.length > 44);
    assert.equal(out.slice(0, 4).toString(), 'RIFF');
    assert.equal(out.slice(8, 12).toString(), 'WAVE');
  });

  test('rejects on garbage input', async () => {
    await assert.rejects(
      transcodeToWav(Buffer.from('not audio at all, just bytes')),
      /ffmpeg exit/
    );
  });
});
