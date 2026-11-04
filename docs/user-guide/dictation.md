# Voice Dictation

FastAF includes local voice-to-text using Whisper AI. All processing happens on your machine — no cloud services.

## Setup

1. Open **Settings → Dictation**
2. Enable dictation
3. Download a Whisper model under **Speech recognition** (recommended: `large-v3-turbo`, ~1.6 GB)
4. Wait for download to complete (progress shown in UI)
5. Optionally configure the hotkey, the microphone and the language

The page has one titled section per job: **Dictation** (enable, hotkey,
auto-send), **Speech-to-text provider**, **Speech recognition** (input device,
language and voice tuning) with **Speech assets** (the Whisper models), **AI
Rewrite**, and **Auto-Corrections**. Each section keeps its own advanced
settings at its bottom; there is no shared "Advanced" section.

On desktop that is the whole page. Upstream TUICommander's **Hands-free
conversation** and **Spoken replies** sections, and its Pocket TTS voices, are
shown only in browser mode. On desktop, FastAF's voice agent (**Settings →
Voice**) is the hands-free mode: it listens, answers out loud with Kokoro, and
runs entirely on this machine.

## Usage

**Push-to-talk workflow:**

1. **Hold** the dictation hotkey (default: `F5`), or click **Speak** in the bar under the terminal
2. **Speak** your text
3. **Release** the key/button
4. Transcribed text is inserted into the focused input element (textarea, input, or contenteditable). If no text input has focus, the text falls back to the active terminal PTY. The focus target is captured at key-press time.

The hotkey works globally — even when FastAF is not focused.

Pauses do not discard preceding speech from the live preview. Streaming passes
non-zero audio windows through the same speech gates used by the final
transcription; the final pass processes the complete retained recording.

## Hands-Free Conversation (browser mode)

This section describes upstream's hands-free conversation, which FastAF offers
only in browser mode, where a browser holds the conversation through its own
microphone and speaker. On desktop it is not shown and its shortcut does
nothing; use FastAF's voice agent (**Settings → Voice**) instead.

Push-to-talk sends one dictation to whatever has focus. Hands-free is the other
mode: it binds **one** terminal, keeps the microphone open, and sends each
utterance by itself.

To start it on the terminal you are looking at, press `Cmd+Alt+V`
(`Ctrl+Alt+V` on Windows/Linux; rebind `toggle-hands-free` in Settings →
Keyboard Shortcuts); press it again to stop. The Command Palette has no entry
for it. The binding does not follow focus: switch tabs and the conversation
stays with the terminal you started it on. You can also choose a terminal in
**Settings → Dictation → Hands-free conversation** and select **Start
conversation**.

Hands-free conversation uses an accent **Start conversation** action and a distinct **Stop conversation** action. The state row shows a coloured indicator with **Running** or **Stopped**, alongside the backend phase when available.

While it runs, the panel shows the state, the bound terminal, where the audio
comes from, and the text that is about to be sent. The dictation hotkey stops
the conversation, and so does **Stop conversation**.

With an activation phrase, **Listening** means the microphone is waiting or
hearing speech that has not yet matched. **Go ahead** means local recognition
matched your phrase during the open utterance. Prefix checks cover its first
four seconds; their speed depends on your model and machine. **Transcribing**
means the utterance has ended and the final pass is running. A partial wake
match is only an acknowledgement: the final transcript still decides whether
the speech is addressed here and can be sent.

You do not need to watch the screen: two short rising notes mean your turn was
sent to the agent, and two softer falling notes mean the activation phrase was
missing and the turn was dropped. Only the device you are talking into plays
them. Turn them off with the **Earcons** setting.

| Control | What it does |
|---------|--------------|
| Activation phrase | When set, only speech that opens with this phrase is sent, and the phrase is removed first. Case, punctuation and accents do not matter, and the usual transcription variants (a joined `Sentimac`, an extra letter as in `Mack`) still count. Leave it empty to send every utterance. The match runs on your machine. The field suggests `computer`: it is distinctive, Whisper transcribes it reliably, and ordinary speech rarely contains it. |
| Hold-back before sending | How long a finished utterance stays visible before it goes to the terminal, so you can stop one you did not mean. With an activation phrase, the effective delay is at least five seconds to include a continuation. It applies to the next conversation, not to the one already running. |
| Earcons | Plays the short sounds described below when a turn is sent or dropped. On by default. |
| Notify model when hands-free changes | Tells the agent that it can answer out loud when the conversation starts, and to go back to text when it ends. |
| Start notice | Shown while **Notify model** is on. The text the agent reads when the conversation starts; the built-in text is shown in grey. Write your own instructions here; leave it empty or press **Reset to default** to send the built-in text. Line breaks are sent as spaces. When the dictation language is set explicitly, FastAF adds "Reply in &lt;language&gt;." to the notice itself. |

Speech is typed straight into the bound terminal. It does not wait for the
agent to finish: a turn is typed at once, even while the agent is working, the
same as when you type into a busy agent by hand. It does not use the Compose
queue, so commands you queued there keep their order and their timing. A
permission prompt, or text you are typing in the terminal, **keeps** your turn
until it is gone — your speech is never typed into a dialog. A kept turn stays
visible in the hands-free panel, and anything you say meanwhile is added to it,
so it arrives as one message in the order you said it. The conversation ends by
itself when the bound terminal closes or the audio device goes away.

Say the activation phrase on its own to open a short window in which the
following turns need no phrase.
After a phrase addressed with the activation phrase, you can pause and
continue speaking within five seconds without repeating it. The pending text
is sent as one message; the hold-back is at least five seconds while the
phrase is configured, even if you saved a shorter delay.

## Spoken Replies

The agent can answer out loud, and the voice runs **on this machine**: nothing
you say or hear leaves the computer. On desktop, FastAF's voice agent speaks
through **Kokoro** (on-device, selectable voices and speed; **Settings →
Voice**).

The rest of this section applies to browser mode, where upstream's hands-free
spoken replies are available. They use **Pocket TTS** by default: **Settings →
Dictation → Spoken replies** lists one shared runtime library plus a bundle per
language, each with its own voices (English, French, German, Italian, Portuguese
and Spanish). Both are downloads; until one is installed the Dictation page says
what is missing instead of staying silent.

Echo cancellation, hush, volume and levelling work the same for every engine.
Expert mode adds a **Speech engine** setting with one more choice:

- **External command** pipes the reply text to a program you name.

FastAF has no online speech engine: no reply text ever leaves the machine. A
configuration carried over from upstream TUICommander that named its online
engine speaks with Pocket TTS.

Replies are spoken in the language of the conversation. When the dictation
language is set to auto-detect, nothing is spoken until somebody speaks — the
language of the first utterance decides.
The agent is told which language to reply in once: in the start notice when the
language is set explicitly, otherwise on your first spoken turn as
`(reply in Italian)`. Later turns in the same language are sent exactly as you
said them; the hint returns only when you switch language.
The language list marks every language with no bundle as "no spoken
replies". You can still dictate in it, but replies stay silent, and Whisper
expects you to speak that language — choose the one you speak, or Auto-detect.

Talk over a reply and it stops within about a fifth of a second, and what you
say becomes the next turn. Echo cancellation runs on the captured audio, so the reply coming out of
your own speaker does not interrupt itself and does not become a turn.

## Models

| Model | Size | Quality |
|-------|------|---------|
| small | ~488 MB | Good |
| small.en | ~488 MB | Good (English-only) |
| medium-q5 | ~539 MB | Better — Medium quantized to Q5 |
| medium-q8 | ~823 MB | Better — Medium quantized to Q8, close to the full model |
| medium | ~1.5 GB | Better |
| medium.en | ~1.5 GB | Better (English-only) |
| large-v3-turbo-q5 | ~574 MB | Best quality per MB — Turbo quantized to Q5 |
| large-v3-turbo-q8 | ~874 MB | Turbo quantized to Q8, close to the full model |
| large-v2 | ~3.0 GB | Highest accuracy (slow) |
| **large-v3-turbo** | **~1.6 GB** | **Best (recommended, default)** |

The `-q5` / `-q8` models are whisper.cpp's own quantized conversions of the same weights: a third to a half of the download and memory, faster to load and run, for a small accuracy cost (Q8 is nearly indistinguishable from the full model, Q5 slightly less accurate).

Models are downloaded to `<config_dir>/models/` and cached between sessions.

## Languages

Auto-detect (default), or set explicitly:
English, Spanish, French, German, Italian, Portuguese, Dutch, Japanese, Chinese, Korean, Russian.

## Text Corrections

Configure word replacements applied after transcription:

| Spoken | Replaced with |
|--------|---------------|
| "new line" | `\n` |
| "tab" | `\t` |
| "period" | `.` |

Add custom corrections in Settings → Dictation → Auto-Corrections.

## Audio Device

Select which microphone to use from **Input device** in Settings → Dictation → Speech recognition. Lists all available input devices.

## Voice Tuning

Settings > Dictation > Speech recognition → Voice tuning records a test phrase and shows the result in
the panel — nothing is sent to a terminal. Use it to set two gates that decide
whether captured audio counts as speech.

| Control | What it does |
|---------|--------------|
| Level gate | Audio quieter than this never reaches Whisper. The marker on the meter is the gate; the bar is your live level. |
| Speech confidence gate | Discards a transcript when Whisper itself reports it probably heard no speech. Lower is stricter; 100% turns it off. |

When a recording produces no text, the panel says why ("Rejected: ..."). Without
that line a gate that swallowed your speech and a microphone that captured
nothing look identical.

**Symptom → fix:**

- Random "Grazie" / "Thank you" appear when you are not speaking — usually a
  distant microphone that keeps picking up room noise. Raise the level gate until
  room noise sits below the marker, then lower the speech confidence gate.
- Quiet speech is dropped — lower the level gate, or raise the speech confidence
  gate toward 100%.

## Platform Notes

- **macOS:** GPU-accelerated transcription via Metal
- **Windows:** GPU-accelerated transcription via Vulkan
- **Linux:** CPU-only (optional CUDA/Vulkan build feature)
- Microphone permission is requested on first use (not at app startup)

## Status Indicators

| Indicator | Meaning |
|-----------|---------|
| **Speak** (bar under the terminal) | Click to start recording into the compose card; ■ stops |
| Recording animation | Audio is being captured |
| Live level meter in the dictation preview | The selected microphone is receiving sound; it appears immediately while recording |
| Processing spinner | Whisper is transcribing |
| Model downloading | Progress bar with percentage |

## Hotkey Configuration

Change the push-to-talk hotkey in Settings → Dictation. The hotkey is registered globally via Tauri's global-shortcut plugin.

Default: `F5`

### Auto-Send

Enable **Auto-send** in Settings → Dictation to submit the terminal input after transcription. In terminal **Chat** mode, dictation with transcript focus opens the compose dock and types into its field; with Auto-send on, the dock sends it as it would a typed prompt. In a detached terminal window, which has no dock, dictation inserts at the captured Compose selection and uses the normal Compose Send action exactly once, including draft cleanup after success. With Auto-send off, the text stays in the dock or Compose for review. Other editors, search fields and form inputs never submit automatically.

Mobile **Dictate into draft** uses browser speech recognition and stays review-only; tap Send when ready. The separate hands-free conversation sends through its existing server-owned path.

## AI Chat voice targets

In browser mode, in Settings → Dictation → Hands-free conversation, choose an **AI Chat** entry in **Target**, then select **Start conversation**. On desktop, talk to AI Chat through the voice agent (**Settings → Voice**) instead. Attached chats are available whether the panel is docked or detached. Spoken turns use the same ACP prompt queue as typed turns. The chat can answer through the existing voice tool and speech engine. Changing the voice target stops the previous conversation; select Start to bind the new target. Closing the bound tab or its last panel view, selecting another chat, or stopping ego also stops its voice binding. Moving the panel between docked and detached views does not change the target.
