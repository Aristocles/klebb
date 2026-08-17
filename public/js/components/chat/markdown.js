// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/chat/markdown.js
// Assistant text is untrusted model output: marked renders it (same gfm +
// breaks flags as the server), DOMPurify strips scripts, event handlers
// and javascript:/data: URLs, and links open in a new tab with the opener
// severed.

import { marked } from 'https://esm.sh/marked@15.0.7';
import DOMPurify from 'https://esm.sh/dompurify@3.2.4';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(src) {
  const raw = marked.parse(src ?? '');
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
