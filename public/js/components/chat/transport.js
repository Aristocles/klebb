// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/chat/transport.js
// The chat wire: streamed turns, turn reattach, stop, and conversation
// CRUD. A turn is a POST to /api/chat with stream:true whose response is
// a server-sent event stream (status/token/reset/reply/error/stopped/
// done); fetch + ReadableStream because EventSource cannot POST. A JSON
// response is tolerated everywhere a stream is expected: pre-stream
// errors (400/409/503) are JSON by design, and a proxy that strips SSE
// degrades to the buffered reply instead of breaking chat.

function parseSseFrame(frame) {
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':') || !line.trim()) continue;
    if (line.startsWith('id:')) id = Number.parseInt(line.slice(3).trim(), 10);
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  let data = {};
  try { data = JSON.parse(dataLines.join('\n')); } catch { return null; }
  return { event, id, data };
}

export async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const ev = parseSseFrame(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
      if (ev) onEvent(ev);
    }
  }
}

// POST one turn. Resolves {kind:'stream'} after the event stream ends, or
// {kind:'json', status, json} when the server answered plain JSON.
export async function streamChat({ body, signal, onEvent }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
    cache: 'no-store',
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('text/event-stream')) {
    let json = null;
    try { json = await res.json(); } catch {}
    return { kind: 'json', status: res.status, json };
  }
  await readSse(res, onEvent);
  return { kind: 'stream' };
}

// Reattach to a running (or just-finished) turn. Resolves 'none' when
// there is nothing to attach to, 'stream' after replay + live completion.
export async function reattachTurn({ conversationId, afterId, signal, onEvent }) {
  const suffix = afterId ? `?after=${afterId}` : '';
  const res = await fetch(`/api/chat/turn/${encodeURIComponent(conversationId)}${suffix}`, {
    signal,
    cache: 'no-store',
  });
  if (res.status === 204) return 'none';
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream')) return 'none';
  await readSse(res, onEvent);
  return 'stream';
}

// Ask the server to abort the running turn. Fire-and-forget from the
// caller's point of view; a 404 just means it already finished.
export function stopTurn(conversationId) {
  return fetch(`/api/chat/turn/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    cache: 'no-store',
  }).catch(() => {});
}

export async function createConversation() {
  const res = await fetch('/api/conversations', { method: 'POST', cache: 'no-store' });
  if (!res.ok) throw new Error(`conversation create failed: ${res.status}`);
  return (await res.json()).conversation;
}

export async function listConversations() {
  const res = await fetch('/api/conversations', { cache: 'no-store' });
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.conversations) ? body.conversations : [];
}

// Search is a POST because the needle is chat text and access logs record
// URLs. Rows come back as list() summaries, plus a `snippet` when the hit was
// in a message rather than the title.
export async function searchConversations(q) {
  const res = await fetch('/api/conversations/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q }),
    cache: 'no-store',
  });
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.conversations) ? body.conversations : [];
}

export async function renameConversation(id, title) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    cache: 'no-store',
  });
  return res.ok;
}

export async function deleteConversation(id) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    cache: 'no-store',
  });
  return res.ok;
}

export async function getConversation(id) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()).conversation;
}

export async function putConversationMessages(id, messages) {
  try {
    await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      cache: 'no-store',
    });
  } catch {}
}
