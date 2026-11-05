# Storybook Audio

A multiplatform starting point for turning story-book PDFs into chapter-based,
performed audiobooks. The mobile app uses Expo/React Native (Android, iOS, and
web); the API is a separate FastAPI service.

## Project layout

```text
apps/
  mobile/                 Expo app and user-facing flows
    app/                  Expo Router routes
    src/
      features/           Library, book import, generation, and player features
      services/           API and platform integrations
      theme/              Shared app styling
      components/         Reusable UI
  api/                    FastAPI service
    app/
      api/routes/         HTTP endpoints
      core/               Configuration and infrastructure
      models/             Persistence models (to be added)
      services/           PDF, chapter, script, voice, and audio pipelines
      workers/            Long-running generation jobs (to be added)
packages/
  shared/                 TypeScript contracts shared with the mobile app
```

## Getting started

Requirements: Node.js and npm; Python 3.11+ for the API.

```sh
npm install
npm run mobile
```

In another terminal:

```sh
cd apps/api
python -m venv .venv
source .venv/bin/activate
pip install -e ".[neural-voice]"
python -m app.services.download_voice_models
uvicorn app.main:app --reload
```

The local neural voice models total about 250 MB and are cached outside the
repository. Piper runs on the API machine, so story text is not sent to a
third-party speech service.

The API health check is at `http://localhost:8000/api/health`; interactive API
docs are at `http://localhost:8000/docs`. The chapter-planning endpoint
`POST /api/audio/chapters` suggests balanced chapter splits or preserves
explicit chapter headings when your story already contains them. Use
**Suggest chapter breaks** in the Chapters tab to preview the plan; conversion
uses the chosen boundaries for chapter pauses and player labels.

To make audio in the app, choose a PDF, Word (`.docx`), OpenDocument Text
(`.odt`), HTML, Markdown, or UTF-8 text file to import its text, or paste story
text and choose **Use this story**. Select **Gentle** narration for the softer
default voice, or **Expressive** when you want a livelier delivery. Then choose
**Convert to audiobook**; the progress indicator shows upload and rendering
status. When conversion finishes, tap **Play** to start audio on the device's
selected output (including connected Bluetooth devices). Sentence timings from
the rendered audio drive the player highlights. **Gentle** uses a calmer pace
and reduced output level; **Expressive** is slightly quicker. **Download WAV**
saves a copy. The neural voices are provided by Piper; its Python package is
GPL-3.0-or-later, and the voice model cards document each training dataset's
license. The app retains a softened eSpeak compatibility mode
(`STORYBOOK_TTS_ENGINE=espeak`), though it will sound more synthetic. Scanned
PDFs without selectable text can be processed with OCR when the optional OCR
packages are installed (`pip install -e ".[ocr]"` in the API venv, plus a local
Tesseract binary on the machine). For a physical device, set the API server address in the app to the computer's
reachable Wi-Fi address (for example, `http://192.168.1.20:8000`). Do not use
`localhost` on a phone: that points to the phone itself. Keep the API running
on the computer with `--host 0.0.0.0`, and connect both devices to the same
Wi-Fi network. The app saves the address on the device. Plain HTTP is permitted
only in Android debug builds; release builds require an HTTPS API endpoint.

## Install on Android

The APK is the mobile client; the FastAPI backend still needs to run on a
computer or hosted server the phone can reach.

### Download from GitHub

[Download the latest Android APK](https://github.com/1adarsh/audiobooks/releases/latest/download/storybook-audio.apk)

To publish a new download, push a version tag such as `v0.1.1`; GitHub Actions
builds the debug APK, production-signed APK, iOS Simulator app bundle, and web
ZIP, then attaches them to that GitHub release. The same workflow deploys the
web app to GitHub Pages. The APK at the link above is debug-signed; use the
`storybook-audio-android-release.apk` asset for production installations.

Before creating a release, add these repository Actions secrets for Android
signing: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. Encode the private keystore
file as a single-line Base64 value; never commit or share the keystore or its
passwords. Enable GitHub Pages with **GitHub Actions** as the deployment source.
The iOS download is a Simulator-only app bundle and cannot be installed on a
physical iPhone; a device IPA requires Apple signing credentials.

### Build locally

Install the Android SDK and Java 17. To build a debug APK for local development
and HTTP API testing, run:

```sh
JAVA_HOME="$HOME/.local/share/storybook-audio/jdk-17" \
ANDROID_HOME="$HOME/Android/Sdk" \
npm run android:debug-apk
```

This creates `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
For a release APK, first create a private signing key and keep a secure backup:

```sh
keytool -genkeypair -v \
  -keystore "$HOME/.storybook-audio-upload-key.jks" \
  -alias storybook-audio -keyalg RSA -keysize 2048 -validity 10000
```

Never commit or share the keystore or its passwords. Build with the same key
for every release:

```sh
export ANDROID_KEYSTORE_FILE="$HOME/.storybook-audio-upload-key.jks"
export ANDROID_KEY_ALIAS="storybook-audio"
read -r -s -p "Keystore password: " ANDROID_KEYSTORE_PASSWORD; printf '\n'
export ANDROID_KEYSTORE_PASSWORD
read -r -s -p "Key password: " ANDROID_KEY_PASSWORD; printf '\n'
export ANDROID_KEY_PASSWORD
JAVA_HOME="$HOME/.local/share/storybook-audio/jdk-17" \
ANDROID_HOME="$HOME/Android/Sdk" npm run android:apk
```

The release APK is written to
`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Configure
the app to use an HTTPS API server before installing a release APK; Android
blocks cleartext API traffic in release builds. Transfer the APK to the phone
and open it to install. For each future APK update, increase `version` and
`android.versionCode` in `apps/mobile/app.json`, then rebuild using the same
signing key. Android can then install it as an in-place update. Back up the key:
an APK signed with a different key cannot update the installed app.

### Local AI analysis

In the API virtual environment, install the optional CPU inference dependencies
and download the models once:

```sh
pip install -e ".[ai]"
python -m app.services.download_models
```

This downloads spaCy's `en_core_web_sm` named-entity model and the MIT-licensed,
quantized ONNX [GoEmotions student model](https://huggingface.co/Cohee/distilbert-base-uncased-go-emotions-onnx)
(about 68 MB). No GPU or PyTorch is required. Models are cached outside the
repository under `~/.cache/storybook-audio/models` by default; set
`STORYBOOK_MODEL_DIR` to use another location. Use **Analyze characters & mood**
in the app to detect named characters, narrator passages, sentence emotions,
and a suggested soundtrack style. The compact emotion model is intended for
suggestions, not authoritative interpretation; review its output. Text analysis
runs in the local API.

Corrections are stored in a local SQLite database at
`~/.local/share/storybook-audio/feedback.sqlite3` and reused for the same book
title. Set `STORYBOOK_DATA_DIR` to change the storage directory. This is
preference memory, not automatic model training or fine-tuning. Remove
`feedback.sqlite3` from that directory to clear saved corrections.

An optional OpenAI-compatible chat-completions endpoint can refine the
soundtrack cue. Configure all three environment variables on the API process:
`STORYBOOK_AI_BASE_URL`, `STORYBOOK_AI_API_KEY`, and `STORYBOOK_AI_MODEL`.
The base URL should be the API root (for example, `https://host.example/v1`),
not the `/chat/completions` path. When enabled, only the locally selected
mood/style/intensity are sent; story text is not sent. Leave them unset to keep
soundtrack selection local.

## Android development

The Android SDK, emulator, and AVD profiles are expected under
`~/Android/Sdk`. Reopen the VS Code terminal after opening this workspace so
the Android, Java 17, and Node.js paths from `.vscode/settings.json` are loaded.
Check connected devices with `adb devices` and available emulators with
`emulator -list-avds`. Android Studio is optional for the Expo workflow.
Building or running an iOS native app requires macOS and Xcode.

## Planned audio pipeline

1. Import PDF, Word, OpenDocument Text, HTML, Markdown, or plain text documents
   and extract their text (with OCR as a later fallback for scanned books).
2. Detect chapter boundaries or let the reader choose a target chapter count.
3. Use local NLP to suggest named characters and narrator passages; let the
   reader correct speakers and save those corrections per book. Narration
   scripts assign stable per-book neural voice profiles to each speaker, and
   the reader can change and reuse those assignments.
4. Classify sentence emotions and suggest soundtrack moods, with reader
   corrections saved per book. The app can generate a speaker- and
   delivery-tagged narration script from analyzed sentences while preserving
   the original wording. Track selection remains future work.
5. Render narration with per-character neural voice assignments and chosen
   chapter boundaries, then mix optional effects and music into chapter audio.
6. Review, regenerate, and play chapters.

Pasting story text into the mobile app and choosing **Convert to audiobook**
sends the text to the local API, which renders a WAV with the configured local
neural voices. The app can play that file and download it. Playback must be
started with **Play** after conversion, which also works around browser autoplay restrictions.
Generated files are kept in the
system temporary directory and are not a durable media library. AI analysis
is a separate step: it suggests character speakers, emotions, and soundtrack
moods. Generated scripts apply distinct neural voice profiles consistently per
speaker and book. Change a speaker's profile in the Characters tab, then
convert the story again to apply it. For scripts over 250 sentences, profiles
apply to the analyzed lines and the selected narration style is used for the
remaining audio. Music tracks are not mixed into playback yet. OCR for scanned
books and long-running background jobs are not implemented.

## Important product considerations

- Keep character voice assignments scoped to a book so the same character stays
  recognizable across its chapters.
- Make chapter count, pronunciation, performance cues, and soundscape
  intensity adjustable by the reader.
- Keep generated music and effects optional, mixed below dialogue, and easy to
  disable.
- Only process books the user has permission to use, and make generated audio
  retention and deletion clear.
