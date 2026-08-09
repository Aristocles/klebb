// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// ingest/extractors/audio.js
// ffmpeg transcode + Fish ASR for audio drops.
//
// Reuses the same pipeline that powers /api/voice/asr: any container ffmpeg
// can decode goes in, 16 kHz mono WAV comes out, Fish returns the transcript.

const fs = require('fs');
const { transcodeToWav } = require('../../voice/transcode');
const voice = require('../../voice/fish');

// A 15 MB compressed upload can decode to well over 100 MB of 16 kHz mono WAV,
// which is then held in memory and posted to the ASR provider. The browser
// voice path is inherently short (someone speaking into a microphone); an
// uploaded file is not, so the extractor bounds the decoded size rather than
// changing transcodeToWav, which the live voice path shares.
//
// 16 kHz x 2 bytes x 1 channel = 32 kB/s, so 60 MB is a bit over half an hour.
const MAX_WAV_BYTES = 60 * 1024 * 1024;
const ASR_TIMEOUT_MS = 300_000;

async function extractAudio(absPath) {
  if (!process.env.FISH_AUDIO_API_KEY || !process.env.FISH_AUDIO_API_KEY.trim()) {
    throw new Error('audio ingest disabled: FISH_AUDIO_API_KEY not set');
  }
  const buf = fs.readFileSync(absPath);
  const wav = await transcodeToWav(buf);
  if (wav.length > MAX_WAV_BYTES) {
    const minutes = Math.round(wav.length / 32000 / 60);
    throw new Error(`audio too long to transcribe (about ${minutes} minutes); split it into shorter recordings`);
  }
  // Without a ceiling here a stalled ASR request holds the ingest queue's only
  // slot indefinitely. The timer is unref'd and cleared either way, so it never
  // keeps the process alive on its own.
  let timer = null;
  try {
    const { text } = await Promise.race([
      voice.asr({ audio: wav, language: 'en' }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`speech recognition timed out after ${Math.round(ASR_TIMEOUT_MS / 1000)}s`)),
          ASR_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
    return { text: text || '' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { extractAudio, MAX_WAV_BYTES, ASR_TIMEOUT_MS };
