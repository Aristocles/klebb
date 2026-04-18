import { LitElement, html, css } from 'https://esm.sh/lit@3';
import { unsafeHTML } from 'https://esm.sh/lit@3/directives/unsafe-html.js';

class HealthChat extends LitElement {
  static properties = {
    _open: { state: true },
    _messages: { state: true },
    _input: { state: true },
    _loading: { state: true },
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
        body: JSON.stringify({ messages }),
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
            <span class="chat-header-sub">Health Assistant</span>
          </div>
          <div class="chat-messages">
            ${this._renderMessages()}
          </div>
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
        </div>
      ` : ''}
      <button class="fab ${this._open ? 'open' : ''}" @click=${this._toggle}>
        ${this._open ? '\u2715' : '\u26A1'}
      </button>
    `;
  }
}

customElements.define('health-chat', HealthChat);
