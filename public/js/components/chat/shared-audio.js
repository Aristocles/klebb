// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/chat/shared-audio.js
// THE audio element iOS unlocks on first user gesture. One module-level
// node, reused forever: only its .src changes per clip. Every pattern here
// is load-bearing on iOS Safari:
//  - the silent ~50ms mp3 gives the very first .play() (inside the mic-tap
//    gesture) real content to satisfy the "activate this element" rule
//  - priming is idempotent; iOS treats the element as activated once
//  - the element parks off-screen in <body> between plays, so stopping it
//    never leaves a dead controls bar in a message bubble

let _sharedAudio = null;

export function getSharedAudio() {
  if (_sharedAudio) return _sharedAudio;
  const el = document.createElement('audio');
  el.preload = 'auto';
  el.controls = true;
  el.playsInline = true;
  el.setAttribute('playsinline', 'playsinline');
  el.setAttribute('webkit-playsinline', 'webkit-playsinline');
  el.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAADAAAB7wCTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5PKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysr///////////////////////////////////////////8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAKjAAAAAAAAAe8wbOiSAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EsQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMRTg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  el.style.top = '0';
  el.style.width = '1px';
  el.style.height = '1px';
  document.body.appendChild(el);
  _sharedAudio = el;
  return el;
}

// Prime inside a user gesture. Safe to call repeatedly.
export function primeSharedAudio() {
  const el = getSharedAudio();
  try {
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => { try { el.pause(); el.currentTime = 0; } catch {} })
       .catch(() => {});
    } else {
      try { el.pause(); } catch {}
    }
  } catch {}
}

// Pause and park the element back off-screen in <body>.
export function stopSharedAudio() {
  const el = _sharedAudio;
  if (!el) return;
  try { el.pause(); } catch {}
  if (el.parentNode && el.parentNode !== document.body) {
    document.body.appendChild(el);
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '0';
    el.style.width = '1px';
    el.style.height = '1px';
  }
}

// The raw element when it already exists (for live playbackRate changes);
// null before first use so callers cannot accidentally create it outside a
// gesture path.
export function peekSharedAudio() {
  return _sharedAudio;
}
