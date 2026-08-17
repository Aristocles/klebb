// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// chat/system-prompt.js
// Assemble the chat system prompt as ordered segments so the stable part of it
// can be cached upstream instead of re-billed on every step.
//
// Prompt caching is a PREFIX match: the gateway hashes the request up to a
// marked breakpoint and serves a hit only if every byte before it is identical.
// One volatile byte early in the prompt therefore makes everything after it
// uncacheable. That is exactly what used to happen here: today's date sat
// second and the card in focus fourth, in front of roughly 25 kB of otherwise
// byte-stable catalogue text.
//
// So segment order is not cosmetic, it is the whole mechanism:
//
//   1. static    same for every turn, conversation and instance until a deploy
//                changes it. The big one (system prompt + the catalogues).
//   2. instance  stable for one instance until its cards or reports change,
//                which includes the agent creating a card mid-conversation.
//   3. volatile  today's date and the card in focus. Small, changes constantly,
//                and carries NO breakpoint so it can invalidate nothing.
//
// A breakpoint caches everything up to itself, not just its own block, so the
// second breakpoint covers static+instance cumulatively. A card change misses
// on the second and still hits on the first, which is the point of having two.
//
// Reordering changes only where each block sits, never its text: the assembled
// prompt is the same content in a different order.

const CACHE_BREAKPOINT = { type: 'ephemeral' };

// Keeps the caller honest about ordering: segments are consumed in this order,
// so a future edit that adds a volatile block has to say where it belongs
// rather than concatenating it wherever it is convenient.
const SEGMENT_ORDER = ['static', 'instance', 'volatile'];

// Which segments carry a cache breakpoint. `volatile` deliberately does not:
// marking it would create a fresh cache entry on every request, and cache
// writes are billed ABOVE uncached input, so it would cost more than doing
// nothing at all.
const CACHEABLE = new Set(['static', 'instance']);

// Build the `messages[0]` system entry.
//
// With caching off, returns the flat string the gateway has always received, so
// the escape hatch is byte-identical to the old behaviour rather than merely
// similar. With caching on, returns typed content blocks carrying breakpoints.
//
// Empty segments are dropped: an instance with no cards and no reports should
// not send an empty block, and it must not move the breakpoint onto nothing.
function buildSystemMessage(segments, { cache = true } = {}) {
  const present = SEGMENT_ORDER
    .map(name => ({ name, text: typeof segments[name] === 'string' ? segments[name] : '' }))
    .filter(seg => seg.text.length > 0);

  if (!cache) {
    return { role: 'system', content: present.map(seg => seg.text).join('') };
  }

  // Collapse each run of consecutive same-cacheability segments into one block,
  // so two adjacent cacheable segments do not burn two of the four available
  // breakpoints when one would do.
  const blocks = [];
  for (const seg of present) {
    const cacheable = CACHEABLE.has(seg.name);
    const last = blocks[blocks.length - 1];
    if (last && last.cacheable === cacheable) last.text += seg.text;
    else blocks.push({ text: seg.text, cacheable });
  }

  return {
    role: 'system',
    content: blocks.map((block, i) => {
      const out = { type: 'text', text: block.text };
      // Only the LAST block of a cacheable run takes the breakpoint: an inner
      // one would cache a prefix nothing ever asks for again.
      const nextDiffers = i === blocks.length - 1 || blocks[i + 1].cacheable !== block.cacheable;
      if (block.cacheable && nextDiffers) out.cache_control = CACHE_BREAKPOINT;
      return out;
    }),
  };
}

// The flat text the prompt assembles to, in segment order. Used by tests to
// prove the reorder preserved content, and by nothing in the request path.
function flattenSegments(segments) {
  return SEGMENT_ORDER
    .map(name => (typeof segments[name] === 'string' ? segments[name] : ''))
    .join('');
}

// The inverse of buildSystemMessage: recover the prompt text from a system
// message whichever shape it is in. Anything inspecting an outgoing payload
// needs this now that `content` is a string in one mode and typed blocks in the
// other, and duplicating the shape check at each call site is how one of them
// ends up quietly asserting against "[object Object]".
function systemMessageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map(block => (block && typeof block.text === 'string' ? block.text : '')).join('');
}

module.exports = {
  buildSystemMessage, flattenSegments, systemMessageText,
  SEGMENT_ORDER, CACHEABLE, CACHE_BREAKPOINT,
};
