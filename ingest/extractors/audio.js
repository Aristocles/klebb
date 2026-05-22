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

async function extractAudio(absPath) {
  if (!process.env.FISH_AUDIO_API_KEY || !process.env.FISH_AUDIO_API_KEY.trim()) {
    throw new Error('audio ingest disabled: FISH_AUDIO_API_KEY not set');
  }
  const buf = fs.readFileSync(absPath);
  const wav = await transcodeToWav(buf);
  const { text } = await voice.asr({ audio: wav, language: 'en' });
  return { text: text || '' };
}

module.exports = { extractAudio };
