// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Aristocles <https://github.com/Aristocles>
// public/js/components/health-chat.js
// Floating chat bubble for Klebb. Supports:
//  - Text chat via /api/chat
//  - Voice chat via /api/voice/tts (POST {text} -> {key,url}; GET /api/voice/tts/:key serves audio)
//    + /api/voice/asr (POST audio -> {text})
//  - Mic button in the input row (no separate voice-mode toggle)
//  - Inline audio controls on every assistant reply (native <audio controls>)
//  - Reliable iOS Safari auto-play via a module-level <audio> element + proper Content-Length/Range
//
// Patterns of note (learned from an earlier voice-chat prototype voice feature):
//  1. Server transcodes all incoming audio to 16kHz mono 16-bit WAV for STT.
//  2. TTS audio served from an in-memory cache with Content-Length + Range support.
//  3. ONE persistent <audio> element (module-level) is the same node iOS unlocks.
//  4. Each message tracks `audioAutoplayed` so re-renders don't replay old replies.
//  5. On startRecording, pause ALL existing audio.
//  6. The voice-mode system prompt returns {speak, display}; we show display, play speak.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { unsafeHTML } from 'https://esm.sh/lit@3/directives/unsafe-html.js';
import { pickStarterPrompts } from '../lib/starter-prompts.esm.js';
import { renderMarkdown } from './chat/markdown.js';
import {
  getSharedAudio, primeSharedAudio, stopSharedAudio, peekSharedAudio,
} from './chat/shared-audio.js';
import {
  streamChat, reattachTurn, stopTurn,
  createConversation, getConversation, putConversationMessages,
} from './chat/transport.js';

// Human copy for the live status line while the agent works a tool.
// Falls back to a generic label so a new tool is never a blank line.
const TOOL_LABELS = {
  create_manifest: 'Creating a card',
  validate_manifest: 'Checking a card design',
  delete_manifest: 'Removing a card',
  patch_manifest: 'Updating a card',
  hide_card: 'Hiding a card',
  show_card: 'Showing a card',
  list_manifests: 'Looking over your cards',
  read_manifest: 'Reading a card',
  read_manifest_meta: 'Reading a card',
  read_manifest_rows: 'Reading your data',
  write_manifest_data: 'Rewriting card data',
  append_row: 'Logging your data',
  update_row: 'Updating an entry',
  remove_row: 'Removing an entry',
  reorder_rows: 'Reordering entries',
  get_recent_activity: 'Checking recent activity',
  hygiene_scan: 'Checking your cards',
  orphan_report: 'Checking data fields',
  rename_data_field: 'Renaming a data field',
  read_doc: 'Reading the manual',
  read_report: 'Reading a report',
  set_notification: 'Setting a reminder',
  remove_notification: 'Removing a reminder',
  note_feature_request: 'Noting your request',
};

function toolLabel(tool, id) {
  const base = TOOL_LABELS[tool] || 'Working on it';
  return id ? `${base} (${id})…` : `${base}…`;
}

class HealthChat extends LitElement {
  static properties = {
    _open: { state: true },
    _messages: { state: true },
    _input: { state: true },
    _loading: { state: true },
    _voiceAvailable: { state: true },
    _chatConfigured: { state: true },
    _recording: { state: true },
    _recordingStarted: { state: true },
    _playbackSpeed: { state: true },
    _playingMsgId: { state: true },
    _isAudioPlaying: { state: true },
    _audioPos: { state: true },
    _speakReplies: { state: true },
    _statusText: { state: true },
    _streamTail: { state: true },
    _agentName: { state: true },
    _agentEmoji: { state: true },
    _expanded: { state: true },
    // Starter chips, populated from /api/manifests on mount then
    // sampled via pickStarterPrompts. See #195.
    _starterChips: { state: true },
    // Ambient stale-card findings from GET /api/hygiene, surfaced as a
    // dismissible nudge in the peek bar. See #452.
    _hygieneFindings: { state: true },
  };

  static styles = css`
    :host { display: block; }

    /* Peek bar — bottom-pinned full-width trigger */
    .peek-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: calc(56px + env(safe-area-inset-bottom, 0px));
      padding-bottom: env(safe-area-inset-bottom, 0px);
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.08);
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 10px;
      padding-left: 16px;
      padding-right: 16px;
      cursor: pointer;
      font-family: inherit;
      border-radius: 16px 16px 0 0;
    }
    .peek-bar[hidden] { display: none; }
    .peek-bar:hover .peek-text {
      color: var(--text-primary);
    }
    .peek-bar:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .peek-icon {
      font-size: 22px;
      line-height: 1;
      flex-shrink: 0;
    }
    .peek-text {
      flex: 1;
      font-size: 14px;
      color: var(--text-secondary);
      text-align: left;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .peek-arrow {
      color: var(--text-muted, var(--text-secondary));
      font-size: 14px;
      flex-shrink: 0;
    }

    /* Stale-card nudge variant of the peek bar (#452). Same geometry,
       gently accented so it reads as a suggestion, not an alert. The
       bar is fixed over page content, so the background stays the
       opaque card colour; the accent lives in the border only. */
    .peek-bar.nudge {
      border-top-color: var(--accent, #00d4aa);
    }
    .peek-bar.nudge .peek-text {
      color: var(--text-primary);
    }
    .nudge-dismiss {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      color: var(--text-muted, var(--text-secondary));
      font-size: 14px;
      line-height: 1;
    }
    .nudge-dismiss:hover {
      background: var(--bg-card, rgba(0, 0, 0, 0.06));
      color: var(--text-primary);
    }
    .nudge-dismiss:focus-visible {
      outline: 2px solid var(--accent, #00d4aa);
      outline-offset: -2px;
    }

    /* Chat panel */
    .chat-panel {
      position: fixed;
      bottom: calc(56px + env(safe-area-inset-bottom, 0px));
      right: 20px;
      width: 380px;
      max-width: calc(100vw - 40px);
      max-height: min(640px, calc(100vh - 80px));
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px 16px 0 0;
      display: flex;
      flex-direction: column;
      z-index: 99;
      box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }
    /* Expanded variant: wider on desktop, taller on phones.
       Width is always clamped to the viewport so nothing can overflow. */
    .chat-panel.expanded {
      width: min(720px, calc(100vw - 40px));
      max-height: min(900px, calc(100vh - 80px));
    }

    .chat-header {
      position: relative;
      padding: 10px 12px 10px 18px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
      /* The header doubles as the swipe-down handle on mobile; vertical
         pans belong to us, not the scroller behind. */
      touch-action: none;
    }
    .chat-header-icon { font-size: 18px; }
    .chat-header-text { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .chat-header-sub {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      margin-left: auto;
    }
    /* Visual swipe affordance, mobile sheet only. */
    .grab-handle {
      display: none;
      position: absolute;
      top: 4px;
      left: 50%;
      transform: translateX(-50%);
      width: 36px;
      height: 5px;
      border-radius: 3px;
      background: var(--border);
    }
    .hdr-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .hdr-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      min-width: 34px;
      height: 30px;
      padding: 0 8px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      font-variant-numeric: tabular-nums;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .hdr-btn:hover { border-color: var(--accent); color: var(--accent); }
    .hdr-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      /* Reaching the top or bottom of the transcript must not hand the
         scroll to the page behind the panel (or trigger its
         pull-to-refresh). */
      overscroll-behavior: contain;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 200px;
      max-height: 360px;
    }
    /* In expanded mode, let the message list grow to fill the taller panel. */
    .chat-panel.expanded .chat-messages {
      max-height: calc(100vh - 220px);
    }

    .msg {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      word-wrap: break-word;
    }
    .msg.user {
      align-self: flex-end;
      background: var(--accent);
      color: var(--text-inverse, white);
      border-bottom-right-radius: 4px;
      white-space: pre-wrap;
    }
    .msg.assistant {
      align-self: flex-start;
      background: var(--bg-input, rgba(0,0,0,0.04));
      color: var(--text-primary);
      border-bottom-left-radius: 4px;
    }
    .msg.assistant strong, .msg.assistant b { color: var(--accent); }
    .msg.assistant em, .msg.assistant i { color: var(--text-secondary); }
    .msg.assistant ul, .msg.assistant ol { padding-left: 18px; margin: 4px 0; }
    .msg.assistant li { margin: 2px 0; }
    .msg.assistant p { margin: 4px 0; }
    .msg.assistant h1, .msg.assistant h2, .msg.assistant h3,
    .msg.assistant h4, .msg.assistant h5, .msg.assistant h6 {
      margin: 8px 0 4px;
      font-size: 1em;
      font-weight: 700;
    }
    .msg.assistant a {
      color: var(--accent);
      text-decoration: underline;
    }
    .msg.assistant del { opacity: 0.7; }
    .msg.assistant pre {
      overflow-x: auto;
      max-width: 100%;
      padding: 8px;
      background: rgba(0, 0, 0, 0.06);
      border-radius: 6px;
      font-size: 12px;
    }
    .msg.assistant blockquote {
      margin: 4px 0;
      padding-left: 10px;
      border-left: 3px solid var(--border, rgba(0, 0, 0, 0.15));
      color: var(--text-secondary);
    }
    .msg.assistant table {
      border-collapse: collapse;
      width: 100%;
      margin: 6px 0;
      font-size: 0.9em;
    }
    .msg.assistant th, .msg.assistant td {
      border: 1px solid var(--border, rgba(0, 0, 0, 0.15));
      padding: 4px 8px;
      text-align: left;
    }
    .msg.assistant thead { background: rgba(0, 0, 0, 0.05); }
    .msg.assistant tbody tr:nth-child(even) { background: rgba(0, 0, 0, 0.02); }
    .msg.assistant input[type="checkbox"] {
      margin-right: 6px;
      vertical-align: middle;
    }
    .msg.error {
      align-self: center;
      background: rgba(255, 68, 102, 0.08);
      color: #ff4466;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 10px;
    }

    /* Message-level audio row: ONE play/pause control per voice reply,
       plus progress while playing and the speed cycler. The shared
       <audio> engine never renders here (#599). */
    .audio-row {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .audio-row .play-btn {
      background: var(--accent);
      color: var(--text-inverse, white);
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .audio-row .seek {
      flex: 1;
      min-width: 60px;
      accent-color: var(--accent);
      height: 4px;
    }
    .audio-row .audio-time {
      font-size: 10px;
      color: var(--text-muted, var(--text-secondary));
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .speed-chip {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 3px 8px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 10px;
      font-family: inherit;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .speed-chip:hover { border-color: var(--accent); color: var(--accent); }

    /* Recording banner */
    .recording-banner {
      padding: 8px 14px;
      background: rgba(255, 68, 102, 0.1);
      color: #ff4466;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      border-top: 1px solid var(--border);
    }
    .rec-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #ff4466;
      animation: rec-pulse 1.2s ease-in-out infinite;
    }
    @keyframes rec-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.3; }
    }
    .rec-time { font-variant-numeric: tabular-nums; margin-left: auto; }

    /* Input row: mic | text | send */
    .chat-input-bar {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      align-items: center;
    }
    .mic-btn, .speak-toggle {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
    }
    .speak-toggle:hover { border-color: var(--accent); color: var(--accent); }
    .speak-toggle.active {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--text-inverse, white);
    }
    .mic-btn:hover:not(:disabled):not(.unconfigured) { border-color: var(--accent); color: var(--accent); }
    .mic-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .mic-btn.unconfigured { opacity: 0.4; cursor: help; }
    .mic-btn.recording {
      background: #ff4466;
      color: white;
      border-color: #ff4466;
      animation: rec-pulse 1.2s ease-in-out infinite;
    }
    .chat-input {
      flex: 1;
      background: var(--bg-input, rgba(0,0,0,0.04));
      color: var(--text-primary);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 8px 14px;
      /* 16px prevents iOS Safari auto-zoom on focus */
      font-size: 16px;
      font-family: inherit;
      outline: none;
      resize: none;
      line-height: 1.4;
      min-height: 36px;
      max-height: 240px;
      overflow-y: auto;
    }
    .chat-input:focus { border-color: var(--accent); }
    .chat-input:disabled { opacity: 0.5; }
    .send-btn {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: none;
      background: var(--accent);
      color: var(--text-inverse, white);
      cursor: pointer;
      font-size: 16px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .empty-state {
      text-align: center;
      color: var(--text-muted, var(--text-secondary));
      font-size: 13px;
      padding: 40px 20px;
    }
    .empty-state .icon { font-size: 28px; margin-bottom: 8px; }
    .empty-state .not-configured {
      margin-top: 8px;
      padding: 10px 12px;
      background: rgba(255, 170, 0, 0.08);
      border: 1px solid rgba(255, 170, 0, 0.3);
      color: var(--text-primary);
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1.5;
      text-align: left;
    }
    .empty-state .not-configured a { color: var(--accent); }
    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: center;
      margin-top: 14px;
    }
    .suggestion {
      background: var(--bg-input, rgba(0,0,0,0.04));
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 14px;
      font-size: 11px;
      cursor: pointer;
      color: var(--text-secondary);
    }
    .suggestion:hover { border-color: var(--accent); color: var(--accent); }
    .suggestion.combine {
      background: var(--accent-amber-bg, rgba(255, 170, 51, 0.12));
      border-color: var(--accent-amber, #ffaa33);
      color: var(--accent-amber, #ffaa33);
      font-weight: 600;
    }
    .suggestion.combine:hover {
      background: var(--accent-amber, #ffaa33);
      color: var(--bg-card);
      border-color: var(--accent-amber, #ffaa33);
    }
    .embellish { margin-top: 10px; }
    .embellish-intro {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }
    .embellish-chips { justify-content: flex-start; margin-top: 0; }

    /* Provisional text streaming in: plain text on purpose. Markdown is
       re-rendered once on the final reply; re-parsing the whole bubble on
       every token is the classic streaming jank. */
    .msg.assistant.streaming {
      white-space: pre-wrap;
      opacity: 0.9;
    }

    /* Live tool activity while the agent works. */
    .status-line {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
      padding: 4px 14px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      animation: rec-pulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }

    .send-btn.stop {
      background: #ff4466;
      font-size: 12px;
    }

    .typing {
      align-self: flex-start;
      padding: 8px 14px;
    }
    .typing-dots { display: flex; gap: 4px; }
    .typing-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--text-muted, var(--text-secondary));
      animation: typing 1.2s ease-in-out infinite;
    }
    .typing-dots span:nth-child(2) { animation-delay: 0.15s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes typing {
      0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
      30%           { opacity: 1;   transform: translateY(-3px); }
    }

    /* Mobile: a true full-screen sheet. 100dvh (the dynamic viewport unit)
       tracks browser chrome as it collapses; 100vh on iOS is the LARGE
       viewport and pushed the old panel's header up under the status bar,
       where taps belong to the OS, not the page (#598). The safe-area
       insets keep every control below the notch and above the home
       indicator, and --kb (set from visualViewport while the keyboard is
       up) lifts the composer above the keyboard, which iOS overlays over
       the page rather than resizing it. */
    @media (max-width: 480px) {
      .chat-panel,
      .chat-panel.expanded {
        top: 0;
        left: 0;
        right: 0;
        bottom: auto;
        width: 100vw;
        max-width: 100vw;
        height: 100dvh;
        max-height: 100dvh;
        border-radius: 0;
        border: none;
        padding-bottom: var(--kb, 0px);
      }
      .chat-messages,
      .chat-panel.expanded .chat-messages {
        max-height: none;
      }
      .chat-header {
        padding-top: max(env(safe-area-inset-top, 0px), 14px);
      }
      .grab-handle { display: block; }
      /* Full-screen already; nothing to expand into. */
      .expand-btn { display: none; }
      .hdr-btn {
        min-width: 44px;
        height: 44px;
        font-size: 15px;
        border-radius: 14px;
      }
      .chat-input-bar {
        padding-bottom: max(env(safe-area-inset-bottom, 0px), 10px);
      }
      .mic-btn, .send-btn, .speak-toggle { width: 44px; height: 44px; }
    }
  `;

  constructor() {
    super();
    this._open = false;
    this._messages = [];
    this._input = '';
    this._loading = false;
    this._voiceAvailable = false;
    this._chatConfigured = null;
    this._recording = false;
    this._recordingStarted = 0;
    this._recordTimerId = null;
    this._abortController = null;
    this._mediaRecorder = null;
    this._recordedChunks = [];
    this._playbackSpeed = parseFloat(localStorage.getItem('klebb-playback-speed') || '1');
    this._playingMsgId = null;
    this._isAudioPlaying = false;
    this._audioPos = null;
    // Whether replies are spoken, for typed and mic input alike. Off until
    // the user opts in; the first mic use flips it on once (a voice-first
    // user clearly wants speak-back), after which it is fully manual.
    this._speakReplies = localStorage.getItem('klebb-speak-replies') === '1';
    this._msgCounter = 0;
    // msgId -> { url, autoplayed }
    // Not persisted: blob URLs don't survive a reload and re-synthesise on
    // demand from the server anyway.
    this._audioCache = new Map();
    this._agentName = 'Chat';
    this._agentEmoji = '\u{1F4AC}'; // 💬 speech balloon
    this._expanded = localStorage.getItem('klebb-chat-expanded') === '1';
    this._saveTimer = null;
    this._starterChips = null;
    this._hygieneFindings = null;
    // The active conversation follows the device: the server owns the
    // transcript, this is just the pointer into it.
    this._conversationId = localStorage.getItem('klebb-active-conversation') || null;
    this._statusText = '';
    this._streamTail = '';
    this._checkVoiceAvailability();
    this._checkChatConfigured();
    this._loadInstance();
    this._loadConversation();
    this._loadStarterChips();
    this._loadHygiene();
  }

  // Produce a short display label for a starter chip. Chip width is
  // constrained by the suggestions row layout; full prompt text
  // stays in the click handler via _useSuggestion().
  _shortenChipLabel(chip) {
    const max = 32;
    const text = chip && chip.text ? chip.text : '';
    if (text.length <= max) return text;
    return text.slice(0, max - 1).trimEnd() + '…';
  }

  // Fetch enabled cards and pick the starter chips once per widget
  // mount. Stable across opens/closes of the widget; re-rolls on page
  // reload. See #195.
  async _loadStarterChips() {
    try {
      const r = await fetch('/api/manifests', { cache: 'no-store' });
      if (!r.ok) return;
      const body = await r.json();
      const entries = Array.isArray(body?.entries) ? body.entries : [];
      const cards = entries
        .filter(e => e && e.meta && e.meta.enabled !== false)
        .map(e => ({
          id: e.id || e.meta?.id,
          label: e.meta?.label,
          chat: e.meta?.chat,
        }));
      this._starterChips = pickStarterPrompts(cards, { count: 7 });
    } catch {
      // Network errors / non-JSON → silently fall through. The render
      // path handles a null _starterChips by showing nothing
      // above the fixed Combine-cards chip, which is still useful.
      this._starterChips = [];
    }
  }

  // Ambient staleness nudge (#452). GET /api/hygiene only ever returns
  // high-confidence stale findings minus dismissals, so anything here is
  // worth a quiet mention in the peek bar. Fetched once per mount, like
  // the starter chips; dismissing re-fetches so the next finding (if any)
  // takes the slot.
  async _loadHygiene() {
    try {
      const r = await fetch('/api/hygiene', { cache: 'no-store' });
      if (!r.ok) { this._hygieneFindings = []; return; }
      const body = await r.json();
      this._hygieneFindings = Array.isArray(body?.findings) ? body.findings : [];
    } catch {
      this._hygieneFindings = [];
    }
  }

  get _nudge() {
    return (this._hygieneFindings && this._hygieneFindings.length)
      ? this._hygieneFindings[0] : null;
  }

  _nudgeText(f) {
    const days = /No entry in (\d+) days/.exec(f.detail || '');
    return days
      ? `${f.cardId} hasn't been updated in ${days[1]} days`
      : `${f.cardId} looks stale`;
  }

  _useNudge() {
    const f = this._nudge;
    if (!f) return;
    window.dispatchEvent(new CustomEvent('klebb-paste-into-chat', {
      detail: { text: `My ${f.cardId} card is stale (${f.detail}) Help me bring it up to date or tidy it up.` },
    }));
  }

  async _dismissNudge(e) {
    // The dismiss button sits inside the peek-bar button; don't let the
    // click bubble up and open the chat panel too.
    e.stopPropagation();
    const f = this._nudge;
    if (!f) return;
    // Optimistic: drop it locally first so the bar reverts immediately.
    this._hygieneFindings = this._hygieneFindings.slice(1);
    try {
      await fetch(`/api/hygiene/${encodeURIComponent(f.cardId)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: f.kind }),
        cache: 'no-store',
      });
    } catch {}
  }

  // ---------- Conversation persistence ----------
  //
  // The server owns the transcript (#603): the active conversation id is
  // the only client-side pointer, and the server appends both sides of
  // every turn itself. The client still PUTs the message list after local
  // mutations (chip consumption, and as a belt-and-braces sync after each
  // turn), debounced so a flurry becomes one write.

  _adoptMessages(raw) {
    const clean = (Array.isArray(raw) ? raw : []).filter(m =>
      m && typeof m === 'object' &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string'
    );
    // Only adopt server state if nothing's been added locally in the
    // meantime (pathological: user typed before the initial GET landed).
    if (this._messages.length === 0) {
      this._messages = clean;
      this._msgCounter = clean.reduce((max, m) => {
        const n = parseInt(String(m.id).match(/^m(\d+)/)?.[1] || '0', 10);
        return n > max ? n : max;
      }, 0);
    }
  }

  async _loadConversation() {
    try {
      if (this._conversationId) {
        const convo = await getConversation(this._conversationId);
        if (convo) {
          this._adoptMessages(convo.messages);
          // An answer may have finished (or still be running) while the
          // app was closed: pick it up.
          this._reattachIfRunning();
          return;
        }
        // The conversation was pruned or deleted elsewhere.
        this._conversationId = null;
        localStorage.removeItem('klebb-active-conversation');
      }
      await this._importLegacyHistory();
    } catch {}
  }

  // One-time fold of the pre-conversations transcript into a conversation.
  // Loses nothing: the create must succeed before the legacy file is
  // cleared, and a failure just leaves everything for the next load.
  async _importLegacyHistory() {
    const r = await fetch('/api/chat/history', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const msgs = Array.isArray(j?.messages) ? j.messages : [];
    if (!msgs.length) return;
    const created = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs }),
      cache: 'no-store',
    });
    if (!created.ok) return;
    const convo = (await created.json()).conversation;
    this._conversationId = convo.id;
    localStorage.setItem('klebb-active-conversation', convo.id);
    this._adoptMessages(convo.messages);
    try { await fetch('/api/chat/history', { method: 'DELETE', cache: 'no-store' }); } catch {}
  }

  async _ensureConversation() {
    if (this._conversationId) return this._conversationId;
    const convo = await createConversation();
    this._conversationId = convo.id;
    localStorage.setItem('klebb-active-conversation', convo.id);
    return convo.id;
  }

  // Pull the server's copy when it is ahead of ours (a turn finished
  // while the app was backgrounded or closed).
  async _refreshConversation() {
    if (!this._conversationId) return;
    const convo = await getConversation(this._conversationId);
    if (!convo) return;
    const localCount = this._messages.filter(m => m.role !== 'error').length;
    if (convo.messages.length > localCount) {
      this._messages = convo.messages;
      this._scrollToBottom();
    }
  }

  // Unpack a /api/chat response's followup block into the extra fields
  // _addMsg stores on the assistant message. Shared by the typed and
  // recorded-voice send paths so chips can't silently drop from one (#463).
  _followupExtras(data) {
    return data.followup ? {
      followupText: data.followup.text,
      embellishments: Array.isArray(data.followup.embellishments) ? data.followup.embellishments : [],
    } : {};
  }

  // Optional fields that ride alongside {id, role, content} when the
  // message carries a CC-embellishment chip row (see #191).
  _persistExtras(m) {
    const out = {};
    if (typeof m.followupText === 'string' && m.followupText) {
      out.followupText = m.followupText;
    }
    if (Array.isArray(m.embellishments) && m.embellishments.length) {
      out.embellishments = m.embellishments;
    }
    // The play affordance survives reloads; the audio itself
    // re-synthesises on demand.
    if (m.hasVoice === true) out.hasVoice = true;
    // So a reloaded transcript can still offer "keep going".
    if (m.capped === true) out.capped = true;
    return out;
  }

  _saveHistory() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushConversation(), 500);
  }

  async _flushConversation() {
    this._saveTimer = null;
    // Never race a running turn: the server is appending to the same
    // conversation, and a whole-replace mid-turn would clobber it.
    if (!this._conversationId || this._loading) return;
    const keep = this._messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && !m.voiceUnconfiguredNotice)
      .map(m => ({ id: m.id, role: m.role, content: m.content, ...this._persistExtras(m) }))
      .slice(-200);
    await putConversationMessages(this._conversationId, keep);
  }

  // "New chat": park the current conversation (it stays on the server)
  // and start fresh. Any in-flight turn is stopped server-side too, so
  // the one-turn lock releases and no orphan reply lands later.
  async _clearHistory() {
    if (this._abortController) {
      this._userAbortedChat = true;
      this._abortController.abort();
      this._abortController = null;
    }
    if (this._loading && this._conversationId) stopTurn(this._conversationId);
    this._loading = false;
    this._statusText = '';
    this._streamTail = '';
    stopSharedAudio();
    this._audioCache.forEach(v => { try { URL.revokeObjectURL(v.url); } catch {} });
    this._audioCache.clear();
    this._messages = [];
    this._playingMsgId = null;
    this._isAudioPlaying = false;
    this._audioPos = null;
    this._conversationId = null;
    localStorage.removeItem('klebb-active-conversation');
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    // Refocus the textarea so the user can type the next message right
    // away. Desktop only: touch keyboards re-popping is jarring.
    this.updateComplete.then(() => {
      if (this._recording) return;
      if (matchMedia('(max-width: 480px)').matches) return;
      const input = this.shadowRoot?.querySelector('.chat-input');
      if (input && !input.disabled) input.focus();
    });
  }

  async _checkVoiceAvailability() {
    try {
      const r = await fetch('/api/voice/config');
      if (r.ok) {
        const s = await r.json();
        this._voiceAvailable = !!s.enabled;
      }
    } catch {}
  }

  async _checkChatConfigured() {
    try {
      const r = await fetch('/api/chat/status');
      if (!r.ok) { this._chatConfigured = false; return; }
      const body = await r.json();
      this._chatConfigured = !!body.configured;
    } catch {
      this._chatConfigured = false;
    }
  }

  async _loadInstance() {
    try {
      const r = await fetch('/api/instance');
      if (r.ok) {
        const j = await r.json();
        if (j.chatAgent) {
          if (j.chatAgent.name) this._agentName = j.chatAgent.name;
          if (j.chatAgent.emoji) this._agentEmoji = j.chatAgent.emoji;
        }
      }
    } catch {}
  }

  // ---------- Message helpers ----------

  _addMsg(role, content, extra = {}) {
    const id = `m${++this._msgCounter}-${Date.now()}`;
    const msg = { id, role, content, ...extra };
    this._messages = [...this._messages, msg];
    this._saveHistory();
    return id;
  }

  _updateMsg(id, patch) {
    this._messages = this._messages.map(m => m.id === id ? { ...m, ...patch } : m);
    this._saveHistory();
  }

  _pushError(content) {
    this._messages = [...this._messages, { role: 'error', content }];
  }

  _isMobile() {
    return matchMedia('(max-width: 480px)').matches;
  }

  _toggle() {
    this._setOpen(!this._open);
  }

  _setOpen(open) {
    if (this._open === open) return;
    this._open = open;
    if (open) {
      // Scroll-to-bottom is handled in updated() so it also fires after
      // async history load races the panel open.
      this._pendingScrollToBottom = true;
      if (this._isMobile()) {
        // The sheet owns the screen: lock the page behind it so scrolling
        // the transcript cannot rubber-band the dashboard, and flag the
        // open sheet for the pull-to-refresh handler in index.html.
        document.body.dataset.klebbSheetOpen = '1';
        document.documentElement.style.overflow = 'hidden';
        this._attachViewportWatch();
        // No autofocus on mobile: the keyboard popping over a just-opened
        // sheet is jarring; the user taps the input when they want it.
      } else {
        this.updateComplete.then(() => {
          const input = this.shadowRoot?.querySelector('.chat-input');
          if (input && !this._recording) input.focus();
        });
      }
    } else {
      this._releaseSheet();
    }
  }

  _releaseSheet() {
    delete document.body.dataset.klebbSheetOpen;
    document.documentElement.style.overflow = '';
    this._detachViewportWatch();
    this.style.removeProperty('--kb');
  }

  // iOS overlays the keyboard instead of resizing the layout viewport, so
  // a bottom-anchored composer disappears behind it. visualViewport is the
  // only signal that works there: its height/offset shrink to the visible
  // region, and the difference becomes bottom padding on the sheet.
  _attachViewportWatch() {
    if (!window.visualViewport || this._vvHandler) return;
    this._vvHandler = () => {
      const vv = window.visualViewport;
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      if (kb > 0) {
        this.style.setProperty('--kb', `${kb}px`);
        this._scrollToBottom();
      } else {
        this.style.removeProperty('--kb');
      }
    };
    window.visualViewport.addEventListener('resize', this._vvHandler);
    window.visualViewport.addEventListener('scroll', this._vvHandler);
  }

  _detachViewportWatch() {
    if (!this._vvHandler || !window.visualViewport) { this._vvHandler = null; return; }
    window.visualViewport.removeEventListener('resize', this._vvHandler);
    window.visualViewport.removeEventListener('scroll', this._vvHandler);
    this._vvHandler = null;
  }

  // Swipe-down on the header closes the sheet (mobile). Pointer events so
  // a mouse drag works the same way, which is also what the e2e drives.
  _headerPointerDown(e) {
    if (!this._isMobile() || this._recording) return;
    if (e.target.closest('.hdr-btn')) return;
    this._dragStartY = e.clientY;
    this._dragging = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }

  _headerPointerMove(e) {
    if (!this._dragging) return;
    const dy = Math.max(0, e.clientY - this._dragStartY);
    const panel = this.shadowRoot?.querySelector('.chat-panel');
    if (panel) {
      panel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
      panel.style.transition = 'none';
    }
  }

  _headerPointerUp(e) {
    if (!this._dragging) return;
    this._dragging = false;
    const dy = Math.max(0, e.clientY - this._dragStartY);
    const panel = this.shadowRoot?.querySelector('.chat-panel');
    if (panel) {
      panel.style.transition = '';
      panel.style.transform = '';
    }
    if (dy > 90) this._setOpen(false);
  }

  updated(changed) {
    // Pin to the latest turn when the panel opens. If history is still
    // loading from the server at that moment, _messages will change
    // shortly and we re-scroll then, clearing the flag afterwards.
    if (this._open && this._pendingScrollToBottom) {
      const container = this.shadowRoot?.querySelector('.chat-messages');
      if (container) {
        container.scrollTop = container.scrollHeight;
        if (this._messages.length > 0) this._pendingScrollToBottom = false;
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this._onGlobalKeydown = (e) => {
      if (e.key === 'Escape' && this._open && !this._recording) {
        this._setOpen(false);
      }
    };
    window.addEventListener('keydown', this._onGlobalKeydown);
    this._onOpenChat = () => {
      if (!this._open) this._toggle();
    };
    window.addEventListener('klebb-open-chat', this._onOpenChat);
    this._onPasteIntoChat = (e) => {
      const text = e.detail?.text || '';
      // Starter prompts are explicit "new workflow" entry points; carrying
      // prior conversation into them bleeds stale context into the reply.
      // Reply modality follows the speak-replies toggle like any other
      // send; the old one-shot voice arming for pastes (#310) is
      // superseded by it.
      this._clearHistory();
      this._input = text;
      if (!this._open) this._toggle();
      this.updateComplete.then(() => {
        const input = this.shadowRoot?.querySelector('.chat-input');
        if (input) {
          input.focus();
          this._autoSize(input);
          // Move caret to end so the user can continue typing after the paste.
          const n = input.value.length;
          input.setSelectionRange(n, n);
        }
      });
    };
    window.addEventListener('klebb-paste-into-chat', this._onPasteIntoChat);

    // Remember the last card the user opened, so a question can be resolved
    // against it server-side. Not reactive state: it only rides the next
    // /api/chat request as immediate context.
    this._onCardFocused = (e) => {
      const id = e?.detail?.id;
      if (typeof id === 'string' && id) this._viewedCardId = id;
    };
    window.addEventListener('klebb-card-focused', this._onCardFocused);

    // Coming back to the foreground: iOS killed any in-flight fetch when
    // the app backgrounded, but the turn kept running server-side (#602).
    // Reattach to a live stream, or pull the finished reply.
    this._onVisibility = () => {
      if (document.visibilityState === 'visible') this._reattachIfRunning();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._releaseSheet();
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    if (this._onGlobalKeydown) {
      window.removeEventListener('keydown', this._onGlobalKeydown);
    }
    if (this._onOpenChat) {
      window.removeEventListener('klebb-open-chat', this._onOpenChat);
    }
    if (this._onPasteIntoChat) {
      window.removeEventListener('klebb-paste-into-chat', this._onPasteIntoChat);
    }
    if (this._onCardFocused) {
      window.removeEventListener('klebb-card-focused', this._onCardFocused);
    }
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      const container = this.shadowRoot?.querySelector('.chat-messages');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  // ---------- Chat pipeline ----------
  //
  // A turn is one streamed POST (#601/#605): status events feed the live
  // status line, token events accumulate into a provisional bubble, and
  // the reply event carries the same final payload the buffered mode
  // returns. The server persists both sides and keeps the turn running if
  // this client vanishes (#602); a plain JSON response is handled too, so
  // pre-stream errors and stripped-SSE proxies degrade gracefully.

  _onTurnEvent(ev) {
    if (ev.event === 'status') {
      this._statusText = ev.data.phase === 'tool' ? toolLabel(ev.data.tool, ev.data.id) : '';
    } else if (ev.event === 'token') {
      this._streamTail = (this._streamTail || '') + (ev.data.text || '');
      this._scrollToBottom();
    } else if (ev.event === 'reset') {
      this._streamTail = '';
    } else if (ev.event === 'reply') {
      this._turnReply = ev.data;
    } else if (ev.event === 'error') {
      this._turnError = ev.data;
    } else if (ev.event === 'stopped') {
      this._turnStopped = true;
    }
  }

  // Run one turn against the active conversation and fold the outcome
  // into the transcript. Shared by the typed and mic paths.
  async _runTurn(userText, useVoice) {
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();
    this._turnReply = null;
    this._turnError = null;
    this._turnStopped = false;
    this._statusText = '';
    this._streamTail = '';
    let aborted = false;
    try {
      const conversationId = await this._ensureConversation();
      const body = {
        conversationId,
        messages: [{ role: 'user', content: userText }],
        voiceMode: useVoice,
      };
      if (this._viewedCardId) body.viewedCardId = this._viewedCardId;
      const outcome = await streamChat({
        body,
        signal: this._abortController.signal,
        onEvent: (ev) => this._onTurnEvent(ev),
      });
      if (outcome.kind === 'json') {
        // Pre-stream refusal, or a proxy stripped the stream down to the
        // buffered reply. Either way the JSON speaks for itself.
        if (outcome.status === 409) {
          this._pushError('Still finishing the previous reply. Give it a moment.');
          this._reattachIfRunning();
        } else if (outcome.json?.error) {
          this._pushError(outcome.json.error);
        } else if (outcome.json?.reply) {
          this._turnReply = outcome.json;
        }
      }
    } catch (e) {
      if (this._userAbortedChat) {
        this._userAbortedChat = false;
        aborted = true;
      } else {
        this._pushError(e.name === 'AbortError' ? 'Request timed out' : 'Failed to connect');
      }
    }
    this._statusText = '';
    this._streamTail = '';
    this._abortController = null;
    if (!aborted) await this._applyTurnOutcome(useVoice);
    this._loading = false;
    this._scrollToBottom();
    this._saveHistory();
  }

  async _applyTurnOutcome(useVoice) {
    if (this._turnError) {
      this._pushError(this._turnError.error || 'Something went wrong.');
      return;
    }
    if (this._turnStopped || !this._turnReply) return;
    const data = this._turnReply;
    const extra = this._followupExtras(data);
    if (data.capped) extra.capped = true;
    if (useVoice || data.speak) {
      const speakText = data.speak || data.reply;
      const displayText = data.reply || data.display || data.speak || '';
      const msgId = this._addMsg('assistant', displayText, { ...extra, speakText, hasVoice: true });
      this._scrollToBottom();
      if (useVoice) await this._generateAndAutoplay(msgId, speakText);
    } else {
      this._addMsg('assistant', data.reply, extra);
    }
  }

  // Stop watching AND stop the turn: the server halts the loop at its
  // next checkpoint, the one-turn lock releases, and no reply is
  // persisted. The user's message stays.
  _stopTurn() {
    if (!this._loading) return;
    if (this._conversationId) stopTurn(this._conversationId);
    if (this._abortController) {
      this._userAbortedChat = true;
      this._abortController.abort();
    }
    this._loading = false;
    this._statusText = '';
    this._streamTail = '';
  }

  // On returning to the foreground (or booting into an active
  // conversation), pick up whatever happened while we were away: a
  // still-running turn resumes its event stream, a finished one is
  // already in the conversation.
  async _reattachIfRunning() {
    if (!this._conversationId || this._loading || this._reattaching) return;
    this._reattaching = true;
    try {
      this._turnReply = null;
      this._turnError = null;
      this._turnStopped = false;
      const result = await reattachTurn({
        conversationId: this._conversationId,
        onEvent: (ev) => this._onTurnEvent(ev),
      });
      if (result === 'none') {
        await this._refreshConversation();
        return;
      }
      this._statusText = '';
      this._streamTail = '';
      // The replayed reply may already be in our transcript (we saw it
      // before backgrounding); only fold it in when it is genuinely new.
      if (this._turnReply) {
        const last = this._messages.filter(m => m.role === 'assistant').at(-1);
        if (!last || last.content !== (this._turnReply.reply || '')) {
          // No autoplay on reattach: there is no user gesture to ride.
          await this._applyTurnOutcome(false);
        }
      }
      this._saveHistory();
    } catch {} finally {
      this._reattaching = false;
      this._loading = false;
    }
  }

  async _sendText() {
    const text = this._input.trim();
    if (!text || this._loading) return;
    this._addMsg('user', text);
    this._input = '';
    this.updateComplete.then(() => {
      const input = this.shadowRoot?.querySelector('.chat-input');
      if (input) this._autoSize(input);
    });
    this._loading = true;
    this._scrollToBottom();
    // Reply modality is the speak-replies toggle, nothing else: on means
    // every reply comes back voice-shaped and autoplays, off means text.
    const useVoice = this._speakReplies && this._voiceAvailable;
    if (useVoice) primeSharedAudio();
    await this._runTurn(text, useVoice);
    // Input lost focus because it was disabled while loading. Put it
    // back so the user can type the next message without re-clicking.
    // Skip on mobile: touch keyboards re-opening uninvited is jarring.
    this.updateComplete.then(() => {
      if (!this._open || this._recording) return;
      if (matchMedia('(max-width: 480px)').matches) return;
      const input = this.shadowRoot?.querySelector('.chat-input');
      if (input && !input.disabled) input.focus();
    });
  }

  _handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendText();
    }
  }

  _autoSize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }

  _useSuggestion(text) {
    this._input = text;
    this._sendText();
  }

  // ---------- Voice: mic -> recording -> transcribe -> chat -> tts -> play ----------

  async _micTap() {
    if (!this._voiceAvailable) {
      // Ephemeral notice: shown in the UI only, not persisted to server
      // history. Otherwise a reload would replay it as a regular assistant
      // reply, which is misleading.
      const already = this._messages.some(m => m.voiceUnconfiguredNotice);
      if (!already) {
        const id = `m${++this._msgCounter}-${Date.now()}`;
        this._messages = [...this._messages, {
          id,
          role: 'assistant',
          content: "Voice isn't configured. Klebb uses Fish Audio for speech. [See docs](https://github.com/Aristocles/klebb/blob/main/docs/VOICE.md) to set it up.",
          voiceUnconfiguredNotice: true,
        }];
        this._scrollToBottom();
      }
      return;
    }

    // CRITICAL: prime the shared audio element inside THIS gesture.
    // Every tap primes it (safe, idempotent on iOS).
    primeSharedAudio();

    // First mic use opts into spoken replies once: a voice-first user
    // clearly wants speak-back, and a typed-first user is never surprised
    // by sound. Only when the preference has never been set; after this
    // the toggle is fully manual.
    if (localStorage.getItem('klebb-speak-replies') === null) {
      this._speakReplies = true;
      localStorage.setItem('klebb-speak-replies', '1');
    }

    if (this._recording) {
      await this._stopRecording();
      return;
    }
    // Pause any existing playing audio before recording.
    stopSharedAudio();
    this._playingMsgId = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let mime = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mime)) {
        mime = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mime)) mime = '';
      }
      this._recordedChunks = [];
      this._mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      this._mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data && e.data.size > 0) this._recordedChunks.push(e.data);
      });
      this._mediaRecorder.addEventListener('stop', async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this._recordedChunks, { type: this._mediaRecorder?.mimeType || mime || 'audio/webm' });
        this._recordedChunks = [];
        this._mediaRecorder = null;
        this._recording = false;
        this._stopRecordTimer();
        await this._handleRecordedBlob(blob);
      });
      this._mediaRecorder.start();
      this._recording = true;
      this._recordingStarted = Date.now();
      this._startRecordTimer();
    } catch (e) {
      console.error('[voice] getUserMedia failed', e);
      this._pushError(`Microphone: ${e.message || 'permission denied'}`);
    }
  }

  async _stopRecording() {
    if (!this._mediaRecorder || this._mediaRecorder.state !== 'recording') {
      this._recording = false;
      return;
    }
    try { this._mediaRecorder.stop(); } catch {}
    // 'stop' handler does the rest
  }

  _startRecordTimer() {
    this._stopRecordTimer();
    this._recordTimerId = setInterval(() => this.requestUpdate(), 250);
  }
  _stopRecordTimer() {
    if (this._recordTimerId) {
      clearInterval(this._recordTimerId);
      this._recordTimerId = null;
    }
  }

  async _handleRecordedBlob(blob) {
    this._loading = true;
    this._scrollToBottom();
    try {
      // Transcribe
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.text || '').trim();
      if (!text) {
        this._pushError('(didn\'t catch that)');
        this._loading = false;
        return;
      }
      this._addMsg('user', text);
      this._scrollToBottom();

      // Spoken input no longer implies a spoken reply: the speak-replies
      // toggle decides for every send. First mic use flipped it on in
      // _micTap, so the default voice-in/voice-out flow still holds.
      await this._runTurn(text, this._speakReplies);
    } catch (e) {
      this._pushError(`Voice error: ${e.message}`);
      this._loading = false;
    } finally {
      this._scrollToBottom();
    }
  }

  async _generateAndAutoplay(msgId, text) {
    if (!text || !msgId) return;
    try {
      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts HTTP ${res.status}`);
      const { url } = await res.json();
      // Cache URL on the message (not autoplayed yet)
      this._audioCache.set(msgId, { url, autoplayed: false });
      this._updateMsg(msgId, { audioUrl: url });

      // Auto-play using the shared audio element.
      await this._playMessage(msgId, /* fromAutoplay */ true);
    } catch (e) {
      console.error('[voice] tts prep failed', e);
      this._pushError(`TTS failed: ${e.message}`);
    }
  }

  // One set of listeners on the shared engine drives the custom controls:
  // the play/pause glyph tracks real playback state instead of staying a
  // permanent play arrow, and timeupdate feeds the progress strip.
  _wireSharedAudio() {
    if (this._audioWired) return;
    const audio = getSharedAudio();
    audio.addEventListener('play', () => { this._isAudioPlaying = true; });
    audio.addEventListener('pause', () => { this._isAudioPlaying = false; });
    audio.addEventListener('ended', () => {
      this._isAudioPlaying = false;
      this._playingMsgId = null;
      this._audioPos = null;
    });
    audio.addEventListener('timeupdate', () => {
      if (!this._playingMsgId) return;
      this._audioPos = {
        t: audio.currentTime || 0,
        d: Number.isFinite(audio.duration) ? audio.duration : 0,
      };
    });
    this._audioWired = true;
  }

  // Play, pause, or resume the audio attached to a message. The shared
  // element stays parked off-screen: it is an engine, not UI (#599).
  async _playMessage(msgId, fromAutoplay = false) {
    const msg = this._messages.find(m => m.id === msgId);
    if (!msg) return;
    this._wireSharedAudio();
    const cached = this._audioCache.get(msgId);
    if (!cached || !cached.url) {
      // Not cached yet — fetch now, then play (manual user-tap path, or
      // a reloaded message whose hasVoice survived but whose blob didn't)
      if (msg.speakText || msg.content) {
        await this._generateAndAutoplay(msgId, msg.speakText || msg.content);
      }
      return;
    }
    if (fromAutoplay && cached.autoplayed) {
      // Don't auto-replay on re-render
      return;
    }

    const audio = getSharedAudio();
    // Same message: toggle pause/resume without restarting the clip.
    if (this._playingMsgId === msgId) {
      if (audio.paused) {
        try { await audio.play(); } catch {}
      } else {
        audio.pause();
      }
      return;
    }

    audio.src = cached.url;
    audio.playbackRate = this._playbackSpeed;
    this._playingMsgId = msgId;
    this._audioPos = null;

    try {
      await audio.play();
      cached.autoplayed = true;
    } catch (e) {
      console.warn('[voice] play rejected', e.message);
      this._playingMsgId = null;
    }
  }

  _seekAudio(msgId, seconds) {
    if (this._playingMsgId !== msgId) return;
    const audio = peekSharedAudio();
    if (!audio) return;
    try { audio.currentTime = seconds; } catch {}
  }

  _toggleSpeakReplies() {
    this._speakReplies = !this._speakReplies;
    localStorage.setItem('klebb-speak-replies', this._speakReplies ? '1' : '0');
    // Turning it on is a user gesture: prime now so the autoplay of the
    // next reply is already authorised on iOS.
    if (this._speakReplies) primeSharedAudio();
  }

  _toggleExpanded() {
    this._expanded = !this._expanded;
    localStorage.setItem('klebb-chat-expanded', this._expanded ? '1' : '0');
    // Pin to the latest turn after resize so the visible viewport
    // doesn't suddenly show old content when the panel grows.
    this._pendingScrollToBottom = true;
  }

  _cyclePlaybackSpeed() {
    const speeds = [0.5, 1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(this._playbackSpeed);
    this._playbackSpeed = speeds[(idx + 1) % speeds.length];
    localStorage.setItem('klebb-playback-speed', String(this._playbackSpeed));
    const audio = peekSharedAudio();
    if (audio) audio.playbackRate = this._playbackSpeed;
  }

  // ---------- Render ----------

  _renderMessages() {
    if (this._messages.length === 0) {
      if (this._chatConfigured === false) {
        return html`
          <div class="empty-state">
            <div class="icon">💊</div>
            <div class="not-configured">
              <strong>Chat agent not configured.</strong>
              Klebb is LLM-first and works best with a chat agent wired up.
              <a
                href="https://github.com/Aristocles/klebb/blob/main/docs/CHAT-AGENT.md"
                target="_blank"
                rel="noopener"
              >See docs</a> to set one up.
            </div>
          </div>
        `;
      }
      const agent = this._agentName || 'the assistant';
      // Chips are picked from the enabled cards' meta.chat.starterPrompts
      // arrays (with generated defaults when absent). The "✨ Combine
      // cards" chip stays hardcoded — it's meta, not per-card. See #195.
      const chips = Array.isArray(this._starterChips) ? this._starterChips : [];
      return html`
        <div class="empty-state">
          <div class="icon">💊</div>
          <div>Ask ${agent} about your data — or ask to add, change, or hide cards.</div>
          <div class="suggestions">
            ${chips.map(chip => html`
              <span
                class="suggestion"
                data-card-id=${chip.cardId || ''}
                data-kind=${chip.kind || 'data'}
                @click=${() => this._useSuggestion(chip.text)}
              >${this._shortenChipLabel(chip)}</span>
            `)}
            <span
              class="suggestion combine"
              @click=${() => this._useSuggestion("I'd like to combine some of my cards into a single view. Which cards do I have that could work well together in a combination card, and what combination-card layout (rings, stack) would fit best? After writing the card, also suggest 2-3 specific embellishments I could layer on — like switching layout, setting a primary donor, adding daily goals, or colour coding segments.")}
            >✨ Combine cards</span>
          </div>
        </div>
      `;
    }
    const lastMsg = this._messages.at(-1);
    return html`
      ${this._messages.map(m => {
        if (m.role === 'assistant') {
          // Voice replies carry an audio row. speakText covers this
          // session; hasVoice survives a reload (the audio itself
          // re-synthesises on demand).
          const hasAudio = m.id && this._voiceAvailable && (m.speakText || m.hasVoice);
          const chips = Array.isArray(m.embellishments) && m.embellishments.length
            ? this._renderEmbellishChips(m)
            : '';
          // A capped reply on the tail of the transcript offers to resume
          // the turn: the loop ran out of budget, not the answer.
          const keepGoing = m.capped && m === lastMsg && !this._loading
            ? html`
              <div class="suggestions embellish-chips">
                <span class="suggestion" @click=${() => this._useSuggestion('keep going')}>▶ Keep going</span>
              </div>`
            : '';
          return html`
            <div class="msg assistant">
              ${unsafeHTML(renderMarkdown(m.content))}
              ${chips}
              ${keepGoing}
              ${hasAudio ? this._renderAudioRow(m) : ''}
            </div>
          `;
        }
        if (m.role === 'error') return html`<div class="msg error">${m.content}</div>`;
        return html`<div class="msg user">${m.content}</div>`;
      })}
      ${this._loading && this._streamTail ? html`
        <div class="msg assistant streaming">${this._streamTail}</div>
      ` : ''}
      ${this._loading ? (this._statusText ? html`
        <div class="status-line"><span class="status-dot"></span>${this._statusText}</div>
      ` : (!this._streamTail ? html`
        <div class="typing"><div class="typing-dots"><span></span><span></span><span></span></div></div>
      ` : '')) : ''}
    `;
  }

  _renderEmbellishChips(msg) {
    const intro = msg.followupText ? html`<div class="embellish-intro">${msg.followupText}</div>` : '';
    return html`
      <div class="embellish">
        ${intro}
        <div class="suggestions embellish-chips">
          ${msg.embellishments.map(e => html`
            <span class="suggestion" @click=${() => this._applyEmbellishment(msg.id, e)}>${e.label}</span>
          `)}
        </div>
      </div>
    `;
  }

  _applyEmbellishment(msgId, embellishment) {
    if (!embellishment || !embellishment.prompt) return;
    // Clear chips on the originating message so they can't be clicked twice.
    this._updateMsg(msgId, { embellishments: [], followupText: '' });
    this._input = embellishment.prompt;
    this._sendText();
  }

  _renderAudioRow(msg) {
    const isCurrent = this._playingMsgId === msg.id;
    const playing = isCurrent && this._isAudioPlaying;
    const pos = isCurrent && this._audioPos && this._audioPos.d ? this._audioPos : null;
    return html`
      <div class="audio-row">
        <button
          class="play-btn"
          @click=${() => this._playMessage(msg.id, false)}
          aria-label=${playing ? 'Pause' : 'Play'}
          title=${playing ? 'Pause' : 'Play'}
        >${playing ? '\u23F8' : '\u25B6'}</button>
        ${pos ? html`
          <input
            class="seek"
            type="range"
            min="0"
            max=${pos.d}
            step="0.1"
            .value=${String(pos.t)}
            aria-label="Seek"
            @input=${(e) => this._seekAudio(msg.id, parseFloat(e.target.value))}
          />
          <span class="audio-time">${this._fmtTime(pos.t)} / ${this._fmtTime(pos.d)}</span>
        ` : ''}
        <button
          class="speed-chip"
          @click=${this._cyclePlaybackSpeed}
          aria-label="Playback speed"
          title="Playback speed"
        >${this._playbackSpeed}x</button>
      </div>
    `;
  }

  _fmtTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  _renderRecordTime() {
    if (!this._recording) return '';
    const s = Math.max(0, Math.floor((Date.now() - this._recordingStarted) / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  render() {
    // Peek-bar placeholder text uses the agent name dynamically
    const askName = this._agentName || 'Chat';
    return html`
      ${this._open ? html`
        <div class="chat-panel ${this._expanded ? 'expanded' : ''}">
          <div
            class="chat-header"
            @pointerdown=${this._headerPointerDown}
            @pointermove=${this._headerPointerMove}
            @pointerup=${this._headerPointerUp}
            @pointercancel=${this._headerPointerUp}
          >
            <div class="grab-handle" aria-hidden="true"></div>
            <span class="chat-header-icon">${this._agentEmoji}</span>
            <span class="chat-header-text">${this._agentName}</span>
            <div class="hdr-actions">
              <button
                class="hdr-btn expand-btn"
                @click=${this._toggleExpanded}
                aria-label=${this._expanded ? 'Shrink chat' : 'Expand chat'}
                aria-pressed=${this._expanded}
                title=${this._expanded ? 'Shrink' : 'Expand'}
              >${this._expanded ? '\u2922' : '\u2921'}</button>
              <button
                class="hdr-btn"
                @click=${this._clearHistory}
                aria-label="New chat"
                title="New chat"
              >\u{1F4DD}</button>
              <button
                class="hdr-btn"
                @click=${this._toggle}
                aria-label="Close chat"
                title="Close"
              >\u2715</button>
            </div>
          </div>
          <div class="chat-messages">${this._renderMessages()}</div>
          ${this._recording ? html`
            <div class="recording-banner">
              <span class="rec-dot"></span>
              <span>Recording — ask your question…</span>
              <span class="rec-time">${this._renderRecordTime()}</span>
            </div>
          ` : ''}
          <div class="chat-input-bar">
            ${this._voiceAvailable ? html`
              <button
                class="speak-toggle ${this._speakReplies ? 'active' : ''}"
                @click=${this._toggleSpeakReplies}
                aria-label="Speak replies"
                aria-pressed=${this._speakReplies}
                title=${this._speakReplies
                  ? 'Replies are spoken. Tap for text-only replies.'
                  : 'Tap to have every reply spoken aloud.'}
              >${this._speakReplies ? '\u{1F50A}' : '\u{1F507}'}</button>
            ` : ''}
            <button
              class="mic-btn ${this._recording ? 'recording' : ''} ${!this._voiceAvailable ? 'unconfigured' : ''}"
              @click=${this._micTap}
              ?disabled=${this._loading && !this._recording}
              title=${!this._voiceAvailable
                ? 'Voice not configured: click for setup info'
                : (this._recording ? 'Stop and send' : 'Start recording')}
              aria-label=${!this._voiceAvailable
                ? 'voice not configured'
                : (this._recording ? 'stop recording' : 'start recording')}
            >${this._recording ? '\u23F9' : '\u{1F3A4}'}</button>
            <textarea
              class="chat-input"
              rows="1"
              placeholder=${this._chatConfigured === false
                ? 'Chat agent not configured'
                : (this._recording ? 'Recording…' : 'Ask about your health...')}
              .value=${this._input}
              @input=${(e) => { this._input = e.target.value; this._autoSize(e.target); }}
              @keydown=${this._handleKeydown}
              ?disabled=${this._loading || this._recording || this._chatConfigured === false}
            ></textarea>
            ${this._loading ? html`
              <button
                class="send-btn stop"
                @click=${this._stopTurn}
                aria-label="Stop"
                title="Stop generating"
              >\u25fc</button>
            ` : html`
              <button class="send-btn" @click=${this._sendText} aria-label="Send" ?disabled=${this._recording || !this._input.trim() || this._chatConfigured === false}>\u2191</button>
            `}
          </div>
        </div>
      ` : ''}
      ${this._nudge && !this._open ? html`
        <button
          class="peek-bar nudge"
          @click=${this._useNudge}
          aria-label="Open chat about a stale card"
        >
          <span class="peek-icon">\u{1F9F9}</span>
          <span class="peek-text">${this._nudgeText(this._nudge)} — tap to tidy up</span>
          <span
            class="nudge-dismiss"
            role="button"
            tabindex="0"
            aria-label="Dismiss this nudge"
            title="Dismiss"
            @click=${this._dismissNudge}
            @keydown=${(e) => { if (e.key === 'Enter' || e.key === ' ') this._dismissNudge(e); }}
          >✕</span>
        </button>
      ` : html`
      <button
        class="peek-bar"
        @click=${this._toggle}
        aria-label="Open chat with ${askName}"
        aria-expanded=${this._open}
        ?hidden=${this._open}
      >
        <span class="peek-icon">${this._agentEmoji}</span>
        <span class="peek-text">Ask ${askName}…</span>
        <span class="peek-arrow" aria-hidden="true">\u25B2</span>
      </button>
      `}
    `;
  }
}

customElements.define('health-chat', HealthChat);
