// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/title.js
// One cheap side-call that names a conversation after its first exchange,
// the way every chat product does it: untitled until the first reply
// lands, then a short model-generated topic pops in. Never blocks a turn;
// the caller fires it after responding and swallows failures.

'use strict';

const TITLE_SYSTEM = 'You name chat conversations. Reply with the title only: two to six plain words, no quotes, no trailing punctuation, no emoji. Name the topic, never the assistant.';

async function generateTitle({ userText, replyText, callGatewayFn, timeoutMs = 20000 }) {
  const gw = await callGatewayFn({
    messages: [
      { role: 'system', content: TITLE_SYSTEM },
      {
        role: 'user',
        content: `First message: ${String(userText || '').slice(0, 500)}\n\nReply: ${String(replyText || '').slice(0, 500)}\n\nTitle:`,
      },
    ],
    timeoutMs,
  });
  const raw = gw?.choices?.[0]?.message?.content || '';
  const title = raw.trim()
    .replace(/^["'‘’“”]+|["'‘’“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  return title || null;
}

module.exports = { generateTitle };
