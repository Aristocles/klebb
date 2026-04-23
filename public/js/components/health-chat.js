// public/js/components/health-chat.js
// Floating chat bubble for Klebb. Supports:
//  - Text chat via /api/chat
//  - Voice chat via /api/voice/tts (POST {text} -> {key,url}; GET /api/voice/tts/:key serves audio)
//    + /api/voice/asr (POST audio -> {text})
//  - Mic button in the input row (no separate voice-mode toggle)
//  - Inline audio controls on every assistant reply (native <audio controls>)
//  - Reliable iOS Safari auto-play via a module-level <audio> element + proper Content-Length/Range
//
// Patterns of note (learned from dadzhealth voice feature):
//  1. Server transcodes all incoming audio to 16kHz mono 16-bit WAV for STT.
//  2. TTS audio served from an in-memory cache with Content-Length + Range support.
//  3. ONE persistent <audio> element (module-level) is the same node iOS unlocks.
//  4. Each message tracks `audioAutoplayed` so re-renders don't replay old replies.
//  5. On startRecording, pause ALL existing audio.
//  6. The voice-mode system prompt returns {speak, display}; we show display, play speak.

import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { unsafeHTML } from 'https://esm.sh/lit@3/directives/unsafe-html.js';

// ---------- Module-level persistent audio element ----------
// This is THE element iOS unlocks on first user gesture. We reuse it forever;
// we only mutate its .src when we want to play a different clip.
let _sharedAudio = null;
function getSharedAudio() {
  if (_sharedAudio) return _sharedAudio;
  const el = document.createElement('audio');
  el.preload = 'auto';
  el.controls = true;
  el.playsInline = true;
  el.setAttribute('playsinline', 'playsinline');
  el.setAttribute('webkit-playsinline', 'webkit-playsinline');
  // Silent ~50ms mp3 so the very first .play() (inside the user-gesture mic tap)
  // has actual content to satisfy iOS's "activate this element" requirement.
  el.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//tAwAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAADAAAB7wCTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5PKysrKysrKysrKysrKysrKysrKysrKysrKysrKysrKysr///////////////////////////////////////////8AAAAATGF2YzYwLjMxAAAAAAAAAAAAAAAAJAKjAAAAAAAAAe8wbOiSAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EsQpg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMRTg8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
  // Park it off-screen (we move it into message bubbles when playing).
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  el.style.top = '0';
  el.style.width = '1px';
  el.style.height = '1px';
  document.body.appendChild(el);
  _sharedAudio = el;
  return el;
}

// Try to prime the shared element inside a user gesture.
// Safe to call repeatedly; iOS treats it as "activated" once.
function primeSharedAudio() {
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

// Pause the shared audio and detach it from whatever bubble it's parked in.
function stopSharedAudio() {
  const el = _sharedAudio;
  if (!el) return;
  try { el.pause(); } catch {}
  // Move back to body (off-screen) so we don't leave a blank controls bar in a bubble.
  if (el.parentNode && el.parentNode !== document.body) {
    document.body.appendChild(el);
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '0';
    el.style.width = '1px';
    el.style.height = '1px';
  }
}

class HealthChat extends LitElement {
  static properties = {
    _open: { state: true },
    _messages: { state: true },
    _input: { state: true },
    _loading: { state: true },
    _voiceAvailable: { state: true },
    _recording: { state: true },
    _recordingStarted: { state: true },
    _playbackSpeed: { state: true },
    _playingMsgId: { state: true },
    _agentName: { state: true },
    _agentEmoji: { state: true },
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

    /* Floating action button — fallback for browsers without :popover-open support */
    .fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-inverse, white);
      border: none;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(14, 165, 233, 0.2);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, background 0.2s;
    }
    .fab:hover { transform: scale(1.1); }
    .fab.open { background: #ff4466; }

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

    .chat-header {
      padding: 14px 18px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .chat-header-icon { font-size: 18px; }
    .chat-header-text { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .chat-header-sub {
      font-size: 11px;
      color: var(--text-muted, var(--text-secondary));
      margin-left: auto;
    }
    .speed-btn {
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
    }
    .speed-btn:hover { border-color: var(--accent); color: var(--accent); }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 200px;
      max-height: 360px;
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
    .msg.error {
      align-self: center;
      background: rgba(255, 68, 102, 0.08);
      color: #ff4466;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 10px;
    }

    /* Message-level audio slot. The shared <audio> element is moved into
       this slot for the currently playing/queued message. */
    .audio-slot {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .audio-slot audio {
      width: 100%;
      height: 32px;
    }
    .audio-slot .play-btn {
      background: var(--accent);
      color: var(--text-inverse, white);
      border: none;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .audio-slot .play-btn[disabled] { opacity: 0.5; cursor: wait; }
    .audio-slot .spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: audio-spin 0.6s linear infinite;
    }
    @keyframes audio-spin { to { transform: rotate(360deg); } }

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
    .mic-btn {
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
    .mic-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .mic-btn:disabled { opacity: 0.4; cursor: not-allowed; }
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

    @media (max-width: 480px) {
      .chat-panel {
        width: 100vw;
        right: 0;
        left: 0;
        bottom: calc(56px + env(safe-area-inset-bottom, 0px));
        max-width: 100vw;
        max-height: calc(100vh - 56px - env(safe-area-inset-bottom, 0px));
        border-radius: 16px 16px 0 0;
      }
      .fab { bottom: 14px; right: 14px; width: 50px; height: 50px; font-size: 20px; }
    }

    /* Older browsers that don't support :popover-open → fall back to FAB.
       Modern browsers hide the FAB (we use the peek bar + panel instead). */
    .fab { display: none; }
    @supports not selector(:popover-open) {
      .peek-bar { display: none; }
      .fab { display: flex; }
    }
  `;

  constructor() {
    super();
    this._open = false;
    this._messages = [];
    this._input = '';
    this._loading = false;
    this._voiceAvailable = false;
    this._recording = false;
    this._recordingStarted = 0;
    this._recordTimerId = null;
    this._abortController = null;
    this._mediaRecorder = null;
    this._recordedChunks = [];
    this._playbackSpeed = parseFloat(localStorage.getItem('klebb-playback-speed') || '1');
    this._playingMsgId = null;
    this._msgCounter = 0;
    // msgId -> { url, autoplayed }
    this._audioCache = new Map();
    this._agentName = 'Chat';
    this._agentEmoji = '\u{1F4AC}'; // 💬 speech balloon
    this._checkVoiceAvailability();
    this._loadInstance();
    this._stallWatcher();
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

  _stallWatcher() {
    // Recover from visibility-change connection stalls
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        fetch('/api/config', { cache: 'no-store' }).catch(() => {});
        if (this._loading && this._abortController) {
          this._abortController.abort();
          this._abortController = null;
          this._loading = false;
          const last = this._messages[this._messages.length - 1];
          if (last && last.role === 'user') {
            this._pushError('Connection interrupted — send again');
          }
        }
      }
    });
  }

  // ---------- Message helpers ----------

  _addMsg(role, content, extra = {}) {
    const id = `m${++this._msgCounter}-${Date.now()}`;
    const msg = { id, role, content, ...extra };
    this._messages = [...this._messages, msg];
    return id;
  }

  _updateMsg(id, patch) {
    this._messages = this._messages.map(m => m.id === id ? { ...m, ...patch } : m);
  }

  _pushError(content) {
    this._messages = [...this._messages, { role: 'error', content }];
  }

  _toggle() {
    this._open = !this._open;
    // When opening, auto-focus the text input after render
    if (this._open) {
      requestAnimationFrame(() => {
        const input = this.shadowRoot?.querySelector('.chat-input');
        if (input && !this._recording) input.focus();
      });
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this._onGlobalKeydown = (e) => {
      if (e.key === 'Escape' && this._open && !this._recording) {
        this._open = false;
      }
    };
    window.addEventListener('keydown', this._onGlobalKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._onGlobalKeydown) {
      window.removeEventListener('keydown', this._onGlobalKeydown);
    }
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      const container = this.shadowRoot?.querySelector('.chat-messages');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  // ---------- Chat pipeline ----------

  async _fetchChat(messages, voiceMode, timeoutMs = 90000) {
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();
    const timeoutId = setTimeout(() => this._abortController?.abort(), timeoutMs);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ messages, voiceMode }),
        signal: this._abortController.signal,
        cache: 'no-store',
      });
      clearTimeout(timeoutId);
      return await res.json();
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  async _sendText() {
    const text = this._input.trim();
    if (!text || this._loading) return;
    this._addMsg('user', text);
    this._input = '';
    this._loading = true;
    this._scrollToBottom();
    const chatMessages = this._messages.filter(m => m.role !== 'error');
    try {
      // Single request, generous timeout. Earlier two-phase retry was meant
      // for stale TCP sockets after visibility-change; in practice it caused
      // confusing "Gateway unavailable" errors on slow (tool-using) replies.
      const data = await this._fetchChat(chatMessages, false, 120000);
      if (data.error) this._pushError(data.error);
      else this._addMsg('assistant', data.reply);
    } catch (e) {
      this._pushError(e.name === 'AbortError' ? 'Request timed out' : 'Failed to connect');
    }
    this._loading = false;
    this._abortController = null;
    this._scrollToBottom();
  }

  _handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendText();
    }
  }

  _useSuggestion(text) {
    this._input = text;
    this._sendText();
  }

  // ---------- Voice: mic -> recording -> transcribe -> chat -> tts -> play ----------

  async _micTap() {
    // CRITICAL: prime the shared audio element inside THIS gesture.
    // Every tap primes it (safe, idempotent on iOS).
    primeSharedAudio();

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

      // Chat (voice mode)
      const chatMessages = this._messages.filter(m => m.role !== 'error');
      let replyData;
      try { replyData = await this._fetchChat(chatMessages, true, 120000); }
      catch (e) {
        this._pushError(e.name === 'AbortError' ? 'Request timed out' : 'Failed to connect');
        return;
      }

      if (replyData.error) {
        this._pushError(replyData.error);
      } else {
        const speakText = replyData.speak || replyData.reply;
        const displayText = replyData.reply || replyData.display || replyData.speak || '';
        const msgId = this._addMsg('assistant', displayText, { speakText });
        this._scrollToBottom();
        // Fetch TTS + auto-play
        await this._generateAndAutoplay(msgId, speakText);
      }
    } catch (e) {
      this._pushError(`Voice error: ${e.message}`);
    } finally {
      this._loading = false;
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

  // Play (or pause if already playing) the audio attached to a message.
  async _playMessage(msgId, fromAutoplay = false) {
    const msg = this._messages.find(m => m.id === msgId);
    if (!msg) return;
    const cached = this._audioCache.get(msgId);
    if (!cached || !cached.url) {
      // Not cached yet — fetch now, then play (manual user-tap path)
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
    // If currently playing this message, toggle pause.
    if (this._playingMsgId === msgId && !audio.paused) {
      audio.pause();
      return;
    }

    // Move the shared <audio> into this message's slot.
    await this.updateComplete;
    const slot = this.renderRoot?.querySelector(`[data-audio-slot="${msgId}"]`);
    if (slot) {
      // Ensure audio element is un-hidden + in the DOM where the user can see it.
      audio.style.position = '';
      audio.style.left = '';
      audio.style.top = '';
      audio.style.width = '100%';
      audio.style.height = '32px';
      slot.appendChild(audio);
    }

    audio.src = cached.url;
    audio.playbackRate = this._playbackSpeed;
    this._playingMsgId = msgId;

    const onEnded = () => {
      audio.removeEventListener('ended', onEnded);
      this._playingMsgId = null;
      this.requestUpdate();
    };
    audio.addEventListener('ended', onEnded);

    try {
      await audio.play();
      cached.autoplayed = true;
      this.requestUpdate();
    } catch (e) {
      console.warn('[voice] play rejected', e.message);
      this._playingMsgId = null;
      this.requestUpdate();
    }
  }

  _cyclePlaybackSpeed() {
    const speeds = [1, 1.25, 1.5, 2];
    const idx = speeds.indexOf(this._playbackSpeed);
    this._playbackSpeed = speeds[(idx + 1) % speeds.length];
    localStorage.setItem('klebb-playback-speed', String(this._playbackSpeed));
    const audio = _sharedAudio;
    if (audio) audio.playbackRate = this._playbackSpeed;
  }

  // ---------- Markdown ----------

  _parseMarkdown(text) {
    let s = String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = s.split('\n');
    const result = [];
    let inList = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^[-•]\s/)) {
        if (!inList) { result.push('<ul>'); inList = true; }
        result.push(`<li>${trimmed.replace(/^[-•]\s/, '')}</li>`);
      } else {
        if (inList) { result.push('</ul>'); inList = false; }
        if (trimmed === '') result.push('');
        else result.push(`<p>${trimmed}</p>`);
      }
    }
    if (inList) result.push('</ul>');
    return result.join('');
  }

  // ---------- Render ----------

  _renderMessages() {
    if (this._messages.length === 0) {
      const agent = this._agentName || 'the assistant';
      return html`
        <div class="empty-state">
          <div class="icon">💊</div>
          <div>Ask ${agent} about your data — or ask to add, change, or hide cards.</div>
          <div class="suggestions">
            <span class="suggestion" @click=${() => this._useSuggestion("What supplements am I taking?")}>Supplements</span>
            <span class="suggestion" @click=${() => this._useSuggestion("What's my injection schedule this week?")}>Injections</span>
            <span class="suggestion" @click=${() => this._useSuggestion("How did I sleep last night?")}>Sleep</span>
            <span class="suggestion" @click=${() => this._useSuggestion("Show my latest blood results")}>Bloods</span>
            <span class="suggestion" @click=${() => this._useSuggestion("Add a card for tracking water intake")}>Add water card</span>
            <span class="suggestion" @click=${() => this._useSuggestion("Add a card for tracking my daily steps")}>Add steps card</span>
            <span class="suggestion" @click=${() => this._useSuggestion("Change the mood card to allow multiple entries per day")}>Tweak mood card</span>
          </div>
        </div>
      `;
    }
    return html`
      ${this._messages.map(m => {
        if (m.role === 'assistant') {
          // Only show the audio play button on messages that were
          // produced in response to voice input (speakText set). Typed
          // input gets a text-only reply — no audio UI.
          const hasAudio = m.id && this._voiceAvailable && m.speakText;
          return html`
            <div class="msg assistant">
              ${unsafeHTML(this._parseMarkdown(m.content))}
              ${hasAudio ? this._renderAudioSlot(m) : ''}
            </div>
          `;
        }
        if (m.role === 'error') return html`<div class="msg error">${m.content}</div>`;
        return html`<div class="msg user">${m.content}</div>`;
      })}
      ${this._loading ? html`<div class="typing"><div class="typing-dots"><span></span><span></span><span></span></div></div>` : ''}
    `;
  }

  _renderAudioSlot(msg) {
    const cached = this._audioCache.get(msg.id);
    const isGenerating = this._playingMsgId === msg.id && !cached;
    return html`
      <div class="audio-slot" data-audio-slot="${msg.id}">
        <button
          class="play-btn"
          @click=${() => this._playMessage(msg.id, false)}
          ?disabled=${isGenerating}
          title="Play"
        >${isGenerating ? html`<span class="spinner"></span>` : '\u25B6'}</button>
      </div>
    `;
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
        <div class="chat-panel">
          <div class="chat-header">
            <span class="chat-header-icon">${this._agentEmoji}</span>
            <span class="chat-header-text">${this._agentName}</span>
            ${this._voiceAvailable ? html`
              <button class="speed-btn" @click=${this._cyclePlaybackSpeed} title="Playback speed">${this._playbackSpeed}x</button>
            ` : html`<span class="chat-header-sub">Health Assistant</span>`}
            <button
              class="speed-btn"
              @click=${this._toggle}
              aria-label="Close chat"
              title="Close"
              style="margin-left: 6px; min-width: 28px;"
            >\u2715</button>
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
                class="mic-btn ${this._recording ? 'recording' : ''}"
                @click=${this._micTap}
                ?disabled=${this._loading && !this._recording}
                title=${this._recording ? 'Stop and send' : 'Start recording'}
                aria-label=${this._recording ? 'stop recording' : 'start recording'}
              >${this._recording ? '\u23F9' : '\u{1F3A4}'}</button>
            ` : ''}
            <input
              class="chat-input"
              placeholder=${this._recording ? 'Recording…' : 'Ask about your health...'}
              .value=${this._input}
              @input=${(e) => this._input = e.target.value}
              @keydown=${this._handleKeydown}
              ?disabled=${this._loading || this._recording}
            />
            <button class="send-btn" @click=${this._sendText} ?disabled=${this._loading || this._recording || !this._input.trim()}>\u2191</button>
          </div>
        </div>
      ` : ''}
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
      <button class="fab ${this._open ? 'open' : ''}" @click=${this._toggle}>
        ${this._open ? '\u2715' : '\u{1F9E0}'}
      </button>
    `;
  }
}

customElements.define('health-chat', HealthChat);
