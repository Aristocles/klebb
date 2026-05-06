# Voice chat

Klebb ships with optional voice input (speech-to-text) and voice
replies (text-to-speech), powered by Fish Audio. When configured, a
microphone button appears in the chat input row and every voice-mode
reply gets a native audio control for playback.

Voice is strictly optional. Everything works without it; the mic just
renders greyed out and clicking it points users back here.

---

## 1. How it works

Three HTTP endpoints handle the round-trip:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/voice/asr` | Client uploads recorded audio, server returns transcribed text |
| `POST /api/chat` with `voiceMode: true` | Normal chat turn, but the model is prompted to return a `{ speak, display }` pair |
| `POST /api/voice/tts` | Server synthesises an audio clip, returns a cache key; `GET /api/voice/tts/:key` serves the audio with `Content-Length` + `Range` support |

`GET /api/voice/config` exposes the current status — whether voice is
enabled, the backend tier, remaining credit, and the active voice ID.
The chat widget polls this on boot and decides whether to render the
mic as active or greyed-out.

---

## 2. Configuration

Set these in your env file (e.g. `/etc/klebb.env`):

```ini
FISH_AUDIO_API_KEY=<key>
FISH_AUDIO_DEFAULT_VOICE=<voice-model-id>
```

Then restart the service.

### Picking a voice model ID

Fish Audio exposes a library of voice models; each has a unique ID
(a hex string). Browse models in the Fish Audio dashboard, pick one,
and paste its ID into `FISH_AUDIO_DEFAULT_VOICE`. Users with specific
preferences can override per-instance.

### Sanity check

```bash
curl -s http://127.0.0.1:8080/api/voice/config | jq
# → { "enabled": true, "tier": "...", "credit": ..., "voiceId": "..." }
```

If `enabled` is `false`, voice is off. Common causes are below.

---

## 3. Troubleshooting

**Mic button is greyed and clicking shows "Voice isn't configured".**
`FISH_AUDIO_API_KEY` is unset or the API rejected it. Check
`/api/voice/config` in the browser dev tools for details.

**Voice works but playback is silent on iOS Safari.**
Check that the shared audio element is being primed inside the user
gesture. See the comment block at the top of
`public/js/components/health-chat.js` for the pattern; breaking it
silently disables autoplay on iOS.

**"Insufficient credit" or 402 errors.**
Your Fish Audio account is out of credit. Top up or switch tiers in
the Fish Audio dashboard.

**ASR returns empty text for valid audio.**
The server transcodes all incoming audio to 16kHz mono 16-bit WAV for
STT. If the client-captured audio is unusable (no mic permission, wrong
codec, etc.) the transcode succeeds but STT returns nothing. Check the
browser console for `getUserMedia` errors.

---

## 4. What's NOT included

- No voice selection UI. Users get whatever `FISH_AUDIO_DEFAULT_VOICE`
  points at. Per-user voice picks would need a small settings surface
  and a manifest to persist the choice.
- No wake-word / always-listening. The mic is tap-to-record only.
- No non-Fish-Audio backends. The integration lives in `voice/fish.js`;
  swapping providers means implementing the same ASR/TTS contract.
