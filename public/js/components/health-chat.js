import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { unsafeHTML } from 'https://esm.sh/lit@3/directives/unsafe-html.js';

class HealthChat extends LitElement {
  static properties = {
    _open: { state: true },
    _messages: { state: true },
    _input: { state: true },
    _loading: { state: true },
    _voiceMode: { state: true },
    _recording: { state: true },
    _speaking: { state: true },
    _voiceAvailable: { state: true },
  };

  static styles = css`
    :host { display: block; }

    /* Floating button */
    .fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-inverse);
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
      bottom: 88px;
      right: 20px;
      width: 380px;
      max-width: calc(100vw - 40px);
      max-height: 500px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      z-index: 99;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
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

    .chat-header-icon {
      font-size: 18px;
    }

    .chat-header-text {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .chat-header-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 200px;
      max-height: 350px;
    }

    .msg {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      word-wrap: break-word;
    }

    .msg.user {
      align-self: flex-end;
      background: var(--accent);
      color: var(--text-inverse);
      border-bottom-right-radius: 4px;
    }

    .msg.assistant {
      align-self: flex-start;
      background: var(--bg-input);
      color: var(--text-primary);
      border-bottom-left-radius: 4px;
    }

    .msg.assistant strong, .msg.assistant b { color: var(--accent); }
    .msg.assistant em, .msg.assistant i { color: var(--text-secondary); }
    .msg.assistant ul, .msg.assistant ol { padding-left: 18px; margin: 4px 0; }
    .msg.assistant li { margin: 2px 0; }
    .msg.assistant p { margin: 4px 0; }
    .msg.assistant p:first-child { margin-top: 0; }
    .msg.assistant p:last-child { margin-bottom: 0; }
    .msg.assistant code { background: var(--border); padding: 1px 4px; border-radius: 3px; font-size: 12px; }

    .msg.error {
      align-self: center;
      background: rgba(255, 68, 68, 0.15);
      color: #ff6b6b;
      font-size: 12px;
    }

    .typing {
      align-self: flex-start;
      color: var(--text-muted);
      font-size: 12px;
      padding: 8px 14px;
    }

    .typing-dots {
      display: inline-flex;
      gap: 4px;
    }

    .typing-dots span {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #94a3b8;
      animation: bounce 1.2s infinite;
    }

    .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
    .typing-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    .chat-input-bar {
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      display: flex;
      gap: 8px;
      background: var(--bg-card);
    }

    .chat-input {
      flex: 1;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 16px;
      font-family: inherit;
      outline: none;
      resize: none;
      min-height: 20px;
      max-height: 80px;
    }

    .chat-input:focus { border-color: var(--accent); }

    .chat-input::placeholder { color: var(--text-muted); }

    .send-btn {
      background: var(--accent);
      color: var(--text-inverse);
      border: none;
      border-radius: 10px;
      padding: 0 16px;
      font-size: 16px;
      cursor: pointer;
      font-weight: 700;
      transition: background 0.2s;
      flex-shrink: 0;
    }

    .send-btn:hover { background: var(--accent-hover); }
    .send-btn:disabled { background: var(--bg-disabled); color: var(--text-disabled); cursor: not-allowed; }

    /* Voice mode */
    .mode-btn {
      margin-left: auto;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .mode-btn:hover { border-color: var(--accent); color: var(--accent); }
    .mode-btn.active {
      background: var(--accent);
      color: var(--text-inverse, var(--bg-card));
      border-color: var(--accent);
    }
    .chat-header-sub { margin-left: 0; }
    .voice-bar {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 16px 18px;
      border-top: 1px solid var(--border);
      background: var(--bg-card);
    }
    .mic-btn {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      border: none;
      background: var(--accent);
      color: var(--text-inverse, var(--bg-card));
      cursor: pointer;
      font-size: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s;
      box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3);
    }
    .mic-btn:hover { transform: scale(1.05); }
    .mic-btn.recording {
      background: #ff4466;
      animation: pulse 1.4s ease-in-out infinite;
    }
    .mic-btn.speaking {
      background: var(--accent-amber, #ffaa00);
      animation: pulse 1.6s ease-in-out infinite;
    }
    .mic-btn:disabled { opacity: 0.4; cursor: not-allowed; animation: none; }
    @keyframes pulse {
      0%, 100% { transform: scale(1); box-shadow: 0 2px 8px rgba(255, 68, 102, 0.3); }
      50%      { transform: scale(1.08); box-shadow: 0 4px 16px rgba(255, 68, 102, 0.55); }
    }
    .voice-status {
      font-size: 12px;
      color: var(--text-secondary);
      flex: 1;
    }

    .empty-state {
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
      padding: 40px 20px;
    }

    .empty-state .icon { font-size: 32px; margin-bottom: 10px; }

    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: center;
      margin-top: 12px;
    }

    .suggestion {
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }

    .suggestion:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    @media (max-width: 480px) {
      .chat-panel {
        bottom: 80px;
        right: 10px;
        left: 10px;
        width: auto;
        max-height: 60vh;
      }
      .fab {
        bottom: 14px;
        right: 14px;
        width: 50px;
        height: 50px;
        font-size: 20px;
      }
    }
  `;

  constructor() {
    super();
    this._open = false;
    this._messages = [];
    this._input = '';
    this._loading = false;
    this._abortController = null;
    this._voiceMode = false;
    this._recording = false;
    this._speaking = false;
    this._mediaRecorder = null;
    this._recordedChunks = [];
    this._currentAudio = null;
    this._voiceAvailable = false;
    this._checkVoiceAvailability();

    // When the user switches apps and comes back, the underlying TCP/TLS
    // connection is often dead but the browser doesn't know yet.  Any
    // subsequent fetch() reuses the stale socket and hangs for minutes.
    //
    // Fix: (1) abort any zombie request, (2) warm up a fresh connection
    // with a lightweight probe so the next real request goes through
    // immediately, (3) reset UI state.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Always warm the connection when coming back to the app, even if
        // there's no in-flight request.  A cheap GET to /api/config opens a
        // fresh TCP socket so the next chat POST doesn't hang.
        fetch('/api/config', { cache: 'no-store' }).catch(() => {});

        if (this._loading) {
          if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
          }
          this._loading = false;
          const last = this._messages[this._messages.length - 1];
          if (last && last.role === 'user') {
            this._messages = [...this._messages, { role: 'error', content: 'Connection interrupted - send your message again' }];
          }
        }
      }
    });
  }

  _toggle() {
    this._open = !this._open;
  }

  _scrollToBottom() {
    requestAnimationFrame(() => {
      const container = this.shadowRoot?.querySelector('.chat-messages');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  async _fetchChat(messages, timeoutMs = 90000) {
    if (this._abortController) this._abortController.abort();
    this._abortController = new AbortController();
    const timeoutId = setTimeout(() => this._abortController?.abort(), timeoutMs);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
        body: JSON.stringify({ messages, voiceMode: this._voiceMode }),
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

  async _send() {
    const text = this._input.trim();
    if (!text || this._loading) return;

    this._messages = [...this._messages, { role: 'user', content: text }];
    this._input = '';
    this._loading = true;
    this._scrollToBottom();

    const chatMessages = this._messages.filter(m => m.role !== 'error');

    try {
      // First attempt with a short 15s timeout.  If the TCP socket is stale
      // (common after app-switch on mobile), this fails fast instead of
      // hanging for minutes.  A retry with a full 90s timeout follows.
      let data;
      try {
        data = await this._fetchChat(chatMessages, 15000);
      } catch (firstErr) {
        // First attempt failed (likely stale connection).  Retry once with
        // the full timeout - the browser will open a fresh socket.
        data = await this._fetchChat(chatMessages, 90000);
      }

      if (data.error) {
        this._messages = [...this._messages, { role: 'error', content: data.error }];
      } else {
        this._messages = [...this._messages, { role: 'assistant', content: data.reply }];
      }
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Request timed out - try again' : 'Failed to connect';
      this._messages = [...this._messages, { role: 'error', content: msg }];
    }

    this._loading = false;
    this._abortController = null;
    this._scrollToBottom();
  }

  // --- Voice mode ---

  async _checkVoiceAvailability() {
    try {
      const r = await fetch('/api/voice/config');
      if (r.ok) {
        const s = await r.json();
        this._voiceAvailable = !!s.enabled;
      }
    } catch {}
  }

  // iOS Safari blocks audio playback unless it's initiated from within a
  // user-gesture handler, AND the first play must be on an unlocked
  // AudioContext. Call this from the tap that enters voice mode so later
  // TTS playback (which happens async after the round-trip) works.
  _unlockAudio() {
    try {
      if (!this._audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this._audioCtx = new AC();
      }
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        this._audioCtx.resume();
      }
      // Play a silent buffer to fully unlock
      if (this._audioCtx && !this._audioUnlocked) {
        const buf = this._audioCtx.createBuffer(1, 1, 22050);
        const src = this._audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this._audioCtx.destination);
        src.start(0);
        this._audioUnlocked = true;
      }
    } catch (e) {
      console.warn('[voice] audio unlock failed', e);
    }
  }

  async _toggleVoiceMode() {
    // Run audio unlock FIRST while we're still inside the user gesture
    this._unlockAudio();
    if (this._voiceMode) {
      // Exit voice mode — stop any playback + recording
      this._stopSpeaking();
      if (this._recording) this._stopRecording();
      this._voiceMode = false;
      return;
    }
    // Entering voice mode — request mic permission upfront
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      this._voiceMode = true;
    } catch (e) {
      this._messages = [...this._messages, { role: 'error', content: 'Microphone access denied — can\'t start voice mode.' }];
    }
  }

  async _startRecording() {
    if (this._loading || this._speaking) return;
    if (this._recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer webm/opus — widely supported + small
      let mime = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mime)) {
        mime = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mime)) mime = '';
      }
      this._recordedChunks = [];
      this._mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      this._mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data && e.data.size > 0) this._recordedChunks.push(e.data);
      });
      this._mediaRecorder.addEventListener('stop', async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this._recordedChunks, { type: mime || 'audio/webm' });
        this._recordedChunks = [];
        this._mediaRecorder = null;
        await this._handleRecordedBlob(blob);
      });
      this._mediaRecorder.start();
      this._recording = true;
    } catch (e) {
      console.error('[voice] start recording failed', e);
      this._messages = [...this._messages, { role: 'error', content: 'Couldn\'t start recording' }];
    }
  }

  _stopRecording() {
    if (!this._recording) return;
    try {
      this._mediaRecorder?.stop();
    } catch {}
    this._recording = false;
  }

  async _handleRecordedBlob(blob) {
    // Send the audio bytes to the ASR endpoint
    this._loading = true;
    this.requestUpdate();
    try {
      const res = await fetch('/api/voice/asr', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.text || '').trim();
      if (!text) {
        this._messages = [...this._messages, { role: 'error', content: '(didn\'t catch that — try again)' }];
        this._loading = false;
        return;
      }
      // Push user message + fire the existing send path
      this._messages = [...this._messages, { role: 'user', content: text }];
      this._scrollToBottom();
      const chatMessages = this._messages.filter(m => m.role !== 'error');
      let replyData;
      try {
        replyData = await this._fetchChat(chatMessages, 15000);
      } catch {
        replyData = await this._fetchChat(chatMessages, 90000);
      }
      if (replyData.error) {
        this._messages = [...this._messages, { role: 'error', content: replyData.error }];
      } else {
        this._messages = [...this._messages, { role: 'assistant', content: replyData.reply }];
        this._scrollToBottom();
        // Speak the reply
        await this._speak(replyData.reply);
      }
    } catch (e) {
      this._messages = [...this._messages, { role: 'error', content: `Voice error: ${e.message}` }];
    } finally {
      this._loading = false;
      this._scrollToBottom();
    }
  }

  async _speak(text) {
    if (!text) return;
    this._stopSpeaking();
    this._speaking = true;
    this.requestUpdate();
    try {
      const res = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`tts HTTP ${res.status}`);
      const arrayBuf = await res.arrayBuffer();

      // Prefer the Web Audio API path — iOS Safari allows this once the
      // AudioContext is unlocked (done on first tap). `new Audio()` is
      // unreliable on iOS even after a gesture.
      if (this._audioCtx) {
        if (this._audioCtx.state === 'suspended') {
          try { await this._audioCtx.resume(); } catch {}
        }
        const decoded = await new Promise((resolve, reject) => {
          // decodeAudioData can take either callback or promise; Safari older
          // versions only do callbacks so we use the callback form.
          this._audioCtx.decodeAudioData(arrayBuf.slice(0), resolve, reject);
        });
        const source = this._audioCtx.createBufferSource();
        source.buffer = decoded;
        source.connect(this._audioCtx.destination);
        this._currentAudioSource = source;
        source.onended = () => {
          this._speaking = false;
          this._currentAudioSource = null;
          this.requestUpdate();
        };
        source.start(0);
      } else {
        // Fallback to HTMLAudioElement if AudioContext isn't available
        const blob = new Blob([arrayBuf], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        this._currentAudio = audio;
        audio.addEventListener('ended', () => {
          this._speaking = false;
          URL.revokeObjectURL(url);
          this._currentAudio = null;
          this.requestUpdate();
        });
        audio.addEventListener('error', () => {
          this._speaking = false;
          URL.revokeObjectURL(url);
          this._currentAudio = null;
          this.requestUpdate();
        });
        await audio.play();
      }
    } catch (e) {
      console.error('[voice] tts play failed', e);
      this._speaking = false;
      this._messages = [...this._messages, { role: 'error', content: `Playback failed: ${e.message}` }];
      this.requestUpdate();
    }
  }

  _stopSpeaking() {
    if (this._currentAudio) {
      try { this._currentAudio.pause(); } catch {}
      this._currentAudio = null;
    }
    if (this._currentAudioSource) {
      try { this._currentAudioSource.stop(0); } catch {}
      this._currentAudioSource = null;
    }
    this._speaking = false;
  }

  _toggleMicTap() {
    this._unlockAudio();
    // Tap-to-toggle recording
    if (this._speaking) {
      // Interrupt Axis — tap during speech stops playback AND starts listening
      this._stopSpeaking();
      this._startRecording();
      return;
    }
    if (this._recording) this._stopRecording();
    else this._startRecording();
  }

  _handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._send();
    }
  }

  _useSuggestion(text) {
    this._input = text;
    this._send();
  }

  _parseMarkdown(text) {
    // Simple markdown to HTML
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Convert lines to paragraphs and lists
    const lines = html.split('\n');
    const result = [];
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.match(/^[-•]\s/)) {
        if (!inList) { result.push('<ul>'); inList = true; }
        result.push(`<li>${trimmed.replace(/^[-•]\s/, '')}</li>`);
      } else {
        if (inList) { result.push('</ul>'); inList = false; }
        if (trimmed === '') {
          result.push('');
        } else {
          result.push(`<p>${trimmed}</p>`);
        }
      }
    }
    if (inList) result.push('</ul>');

    return result.join('');
  }

  _renderMessages() {
    if (this._messages.length === 0) {
      return html`
        <div class="empty-state">
          <div class="icon">\u{1F48A}</div>
          <div>Ask me anything about your health data</div>
          <div class="suggestions">
            <span class="suggestion" @click=${() => this._useSuggestion("What supplements am I taking?")}>Supplements</span>
            <span class="suggestion" @click=${() => this._useSuggestion("What's my injection schedule this week?")}>Injections</span>
            <span class="suggestion" @click=${() => this._useSuggestion("How did I sleep last night?")}>Sleep</span>
            <span class="suggestion" @click=${() => this._useSuggestion("Show my latest blood results")}>Bloods</span>
          </div>
        </div>
      `;
    }

    return html`
      ${this._messages.map(m => {
        if (m.role === 'assistant') {
          return html`<div class="msg assistant">${unsafeHTML(this._parseMarkdown(m.content))}</div>`;
        }
        return html`<div class="msg ${m.role}">${m.content}</div>`;
      })}
      ${this._loading ? html`
        <div class="typing">
          <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>
      ` : ''}
    `;
  }

  render() {
    return html`
      ${this._open ? html`
        <div class="chat-panel">
          <div class="chat-header">
            <span class="chat-header-icon">\u26A1</span>
            <span class="chat-header-text">Axis</span>
            <span class="chat-header-sub">${this._voiceMode ? 'Voice mode' : 'Health Assistant'}</span>
            ${this._voiceAvailable ? html`
              <button
                class="mode-btn ${this._voiceMode ? 'active' : ''}"
                @click=${this._toggleVoiceMode}
                title=${this._voiceMode ? 'Exit voice mode' : 'Start voice chat'}
                aria-label="toggle voice mode"
              >${this._voiceMode ? '\u{1F4AC}' : '\u{1F3A4}'}</button>
            ` : ''}
          </div>
          <div class="chat-messages">
            ${this._renderMessages()}
          </div>
          ${this._voiceMode ? html`
            <div class="voice-bar">
              <button
                class="mic-btn ${this._recording ? 'recording' : ''} ${this._speaking ? 'speaking' : ''}"
                @click=${this._toggleMicTap}
                ?disabled=${this._loading && !this._speaking && !this._recording}
                title=${this._recording ? 'Stop listening' : (this._speaking ? 'Interrupt and speak' : 'Tap to speak')}
              >
                ${this._recording ? '\u{1F534}' : (this._speaking ? '\u{1F508}' : '\u{1F3A4}')}
              </button>
              <div class="voice-status">
                ${this._recording ? 'Listening… tap to stop' :
                  this._speaking ? 'Axis is speaking… tap to interrupt' :
                  this._loading ? 'Thinking…' :
                  'Tap the mic to speak'}
              </div>
            </div>
          ` : html`
            <div class="chat-input-bar">
              <input
                class="chat-input"
                placeholder="Ask about your health..."
                .value=${this._input}
                @input=${(e) => this._input = e.target.value}
                @keydown=${this._handleKeydown}
                ?disabled=${this._loading}
              />
              <button class="send-btn" @click=${this._send} ?disabled=${this._loading || !this._input.trim()}>
                \u2191
              </button>
            </div>
          `}
        </div>
      ` : ''}
      <button class="fab ${this._open ? 'open' : ''}" @click=${this._toggle}>
        ${this._open ? '\u2715' : '\u26A1'}
      </button>
    `;
  }
}

customElements.define('health-chat', HealthChat);
