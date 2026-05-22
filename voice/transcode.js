// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// voice/transcode.js
//
// Pipe a buffer of any audio into ffmpeg and get 16kHz mono 16-bit WAV
// back on stdout. This is the format Fish ASR accepts most reliably
// (advertised opus/mp4 support both reject in practice). Used by the
// /api/voice/asr route and by the inbox ingest pipeline's audio
// extractor; they both feed the same Fish endpoint, so the same
// transcode shape applies.

const { spawn } = require('child_process');

function transcodeToWav(inputBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-sample_fmt', 's16',
      '-f', 'wav',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const outChunks = [];
    let stderr = '';
    ff.stdout.on('data', c => outChunks.push(c));
    ff.stderr.on('data', c => stderr += c.toString());
    ff.on('error', reject);
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
      resolve(Buffer.concat(outChunks));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(inputBuf);
  });
}

module.exports = { transcodeToWav };
