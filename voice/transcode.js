// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// voice/transcode.js
//
// Take any audio buffer and produce 16kHz mono 16-bit WAV (the format
// Fish ASR accepts most reliably; advertised opus/mp4 support both
// reject in practice). Used by the /api/voice/asr route and by the
// inbox ingest pipeline's audio extractor.
//
// Input is written to a tempfile rather than ffmpeg's stdin because
// fragmented MP4 (the only format iOS Safari MediaRecorder produces)
// has its moov atom at the end of the stream and the demuxer must
// seek backward to read it. stdin isn't seekable; a real file is.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function transcodeToWav(inputBuf) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(
      os.tmpdir(),
      `klebb-asr-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
    );

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fs.unlink(tmpPath, () => {});
    };

    fs.writeFile(tmpPath, inputBuf, (writeErr) => {
      if (writeErr) {
        cleanup();
        return reject(writeErr);
      }

      const ff = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-i', tmpPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-sample_fmt', 's16',
        '-f', 'wav',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      const outChunks = [];
      let stderr = '';
      ff.stdout.on('data', c => outChunks.push(c));
      ff.stderr.on('data', c => stderr += c.toString());
      ff.on('error', err => {
        cleanup();
        reject(err);
      });
      ff.on('close', code => {
        cleanup();
        if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 300)}`));
        resolve(Buffer.concat(outChunks));
      });
    });
  });
}

module.exports = { transcodeToWav };
