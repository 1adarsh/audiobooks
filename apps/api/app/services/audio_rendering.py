"""Local WAV narration using Piper neural voices or the eSpeak fallback."""

import array
import io
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import wave
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.services.piper_voices import get_piper_voice_path
from app.services.script_generation import VOICE_PROFILES

MAX_TEXT_LENGTH = 120_000
MAX_CHAPTERS = 12
OUTPUT_DIRECTORY = Path(tempfile.gettempdir()) / "storybook-audio"
SENTENCE_GAP_SECONDS = 0.12
CHAPTER_GAP_SECONDS = 0.6
SENTENCE_PATTERN = re.compile(r'[^.!?\n]+(?:[.!?]+(?:["”’])?|$)')
DEFAULT_VOICE_PROFILE = "gentle_female"


@dataclass(frozen=True)
class SentenceTiming:
    text: str
    start: float
    end: float
    word_starts: list[float]


def _word_weights(sentence: str) -> list[float]:
    words = re.findall(r"\S+", sentence)
    weights: list[float] = []
    for word in words:
        letters = re.sub(r"[^a-z]", "", word.lower())
        syllables = len(re.findall(r"[aeiouy]+", letters))
        if letters.endswith("e") and syllables > 1 and not letters.endswith(("le", "ye")):
            syllables -= 1
        weight = max(syllables, 1) + len(letters) * 0.08
        if re.search(r"[,;:]$", word):
            weight += 0.35
        weights.append(weight)
    return weights


def _active_audio_frame_range(pcm: bytes, channels: int) -> tuple[int, int]:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    frames = len(samples) // channels
    first_active = next(
        (
            frame
            for frame in range(frames)
            if any(
                abs(samples[frame * channels + channel]) > 64
                for channel in range(channels)
            )
        ),
        None,
    )
    if first_active is None:
        return 0, frames
    last_active = next(
        frame
        for frame in range(frames - 1, first_active - 1, -1)
        if any(
            abs(samples[frame * channels + channel]) > 64
            for channel in range(channels)
        )
    )
    return first_active, last_active + 1


def split_sentences(text: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in SENTENCE_PATTERN.findall(text)
        if sentence.strip()
    ]


def _make_chapters(
    text: str,
    chapter_count: int,
    chapter_sentence_counts: list[int] | None = None,
) -> list[str]:
    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("Story text must contain at least one sentence.")

    if chapter_sentence_counts is not None:
        if (
            len(chapter_sentence_counts) != chapter_count
            or any(count < 1 for count in chapter_sentence_counts)
            or sum(chapter_sentence_counts) != len(sentences)
        ):
            raise ValueError("Chapter sentence counts must cover the story exactly.")

        chapters: list[str] = []
        sentence_index = 0
        for count in chapter_sentence_counts:
            chapters.append(" ".join(sentences[sentence_index : sentence_index + count]))
            sentence_index += count
        return chapters

    count = min(chapter_count, len(sentences))
    chapters: list[str] = []
    for chapter_index in range(count):
        start = chapter_index * len(sentences) // count
        end = (chapter_index + 1) * len(sentences) // count
        chapters.append(" ".join(sentences[start:end]))
    return chapters


@lru_cache(maxsize=4)
def _load_piper_voice(profile: str):
    model_path = get_piper_voice_path(profile)
    if not model_path.is_file() or not Path(f"{model_path}.json").is_file():
        raise RuntimeError(
            "Local neural voice models are missing. Run "
            "'python -m app.services.download_voice_models' from apps/api."
        )

    try:
        from piper import PiperVoice
    except ImportError as error:
        raise RuntimeError(
            "Neural voice dependencies are missing. Install the API with "
            "'pip install -e \".[neural-voice]\"'."
        ) from error

    return PiperVoice.load(model_path)


def _synthesize_with_piper(
    text: str,
    profile: str,
    voice_style: str,
) -> bytes:
    try:
        from piper import SynthesisConfig
    except ImportError as error:
        raise RuntimeError(
            "Neural voice dependencies are missing. Install the API with "
            "'pip install -e \".[neural-voice]\"'."
        ) from error

    voice = _load_piper_voice(profile)
    output = io.BytesIO()
    chunks = voice.synthesize(
        text,
        SynthesisConfig(
            length_scale=1.04 if voice_style == "gentle" else 0.96,
            volume=0.82,
        ),
    )
    has_audio = False
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(voice.config.sample_rate)
        for chunk in chunks:
            has_audio = True
            audio.writeframes(chunk.audio_int16_bytes)

    if not has_audio:
        raise RuntimeError("Neural speech synthesis returned empty audio.")
    return output.getvalue()


def render_audio(
    text: str,
    chapter_count: int,
    voice_style: str = "gentle",
    sentence_voice_profiles: list[str] | None = None,
    chapter_sentence_counts: list[int] | None = None,
) -> tuple[str, int, list[SentenceTiming]]:
    """Render an audiobook and return its ID, chapter count, and sentence timings."""
    normalized_text = text.strip()
    if not normalized_text:
        raise ValueError("Story text cannot be empty.")
    if len(normalized_text) > MAX_TEXT_LENGTH:
        raise ValueError(f"Story text must be {MAX_TEXT_LENGTH:,} characters or fewer.")
    if not 1 <= chapter_count <= MAX_CHAPTERS:
        raise ValueError(f"Chapter count must be between 1 and {MAX_CHAPTERS}.")
    if voice_style not in {"gentle", "expressive"}:
        raise ValueError("Voice style must be gentle or expressive.")

    speech_engine = os.environ.get("STORYBOOK_TTS_ENGINE", "neural").strip().casefold()
    if speech_engine not in {"neural", "espeak"}:
        raise ValueError("Speech engine must be neural or espeak.")
    executable = shutil.which("espeak") if speech_engine == "espeak" else None
    if speech_engine == "espeak" and executable is None:
        raise RuntimeError(
            "eSpeak is required for the espeak narration engine. "
            "Install the system package 'espeak' or use the neural engine."
        )

    chapters = _make_chapters(normalized_text, chapter_count, chapter_sentence_counts)
    voice_options = (
        ["-v", "en-us+f3", "-s", "135", "-p", "46", "-a", "80"]
        if voice_style == "gentle"
        else ["-v", "en-us", "-s", "155", "-p", "50", "-a", "80"]
    )
    sentences = split_sentences(normalized_text)
    if sentence_voice_profiles is not None:
        if len(sentence_voice_profiles) > len(sentences):
            raise ValueError("Story has more voice profiles than sentences.")
        if any(profile not in VOICE_PROFILES for profile in sentence_voice_profiles):
            raise ValueError("Story contains an unsupported voice profile.")
    chapter_count_actual = len(chapters)
    chapter_ranges: list[tuple[int, int]] = []
    chapter_start = 0
    for chapter in chapters:
        chapter_end = chapter_start + len(split_sentences(chapter))
        chapter_ranges.append((chapter_start, chapter_end))
        chapter_start = chapter_end

    audio_id = str(uuid.uuid4())
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIRECTORY / f"{audio_id}.wav"
    output = io.BytesIO()
    sentence_timings: list[SentenceTiming] = []
    with wave.open(output, "wb") as combined:
        sample_params: wave._wave_params | None = None
        written_frames = 0
        for sentence_index, sentence in enumerate(sentences):
            profile = (
                sentence_voice_profiles[sentence_index]
                if sentence_voice_profiles is not None
                and sentence_index < len(sentence_voice_profiles)
                else DEFAULT_VOICE_PROFILE
            )
            if speech_engine == "neural":
                wav_data = _synthesize_with_piper(sentence, profile, voice_style)
            else:
                sentence_voice_options = voice_options
                if sentence_voice_profiles is not None and sentence_index < len(sentence_voice_profiles):
                    voice_profile = VOICE_PROFILES[profile]
                    sentence_voice_options = [
                        "-v",
                        voice_profile["voice"],
                        "-s",
                        "135" if voice_style == "gentle" else "155",
                        "-p",
                        str(voice_profile["pitch"]),
                        "-a",
                        "80",
                    ]
                result = subprocess.run(
                    [executable, "--stdout", "--stdin", *sentence_voice_options],
                    input=sentence.encode("utf-8"),
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
                wav_data = result.stdout
            with wave.open(io.BytesIO(wav_data), "rb") as chapter_audio:
                params = chapter_audio.getparams()
                pcm = chapter_audio.readframes(chapter_audio.getnframes())
                frame_size = params.nchannels * params.sampwidth
                frame_count = len(pcm) // frame_size
                if frame_count == 0:
                    raise RuntimeError("Speech synthesis returned empty audio.")
                if sample_params is None:
                    sample_params = params
                    combined.setnchannels(params.nchannels)
                    combined.setsampwidth(params.sampwidth)
                    combined.setframerate(params.framerate)
                elif params[:3] != sample_params[:3]:
                    raise RuntimeError("Audio chapters have incompatible WAV formats.")
                active_start, active_end = _active_audio_frame_range(pcm, params.nchannels)
                sentence_start = written_frames / params.framerate
                active_duration = (active_end - active_start) / params.framerate
                word_weights = _word_weights(sentence)
                total_weight = sum(word_weights)
                word_starts: list[float] = []
                elapsed_weight = 0.0
                for weight in word_weights:
                    word_starts.append(
                        sentence_start
                        + (active_start / params.framerate)
                        + active_duration * (elapsed_weight / total_weight)
                    )
                    elapsed_weight += weight
                sentence_timings.append(
                    SentenceTiming(
                        text=sentence,
                        start=sentence_start + active_start / params.framerate,
                        end=sentence_start + active_end / params.framerate,
                        word_starts=word_starts,
                    )
                )
                combined.writeframes(pcm)
                written_frames += frame_count
                is_chapter_end = any(end == sentence_index + 1 for _, end in chapter_ranges)
                gap_seconds = CHAPTER_GAP_SECONDS if is_chapter_end else SENTENCE_GAP_SECONDS
                silence_frames = int(params.framerate * gap_seconds)
                combined.writeframes(
                    b"\x00" * silence_frames * params.nchannels * params.sampwidth
                )
                written_frames += silence_frames

    output_path.write_bytes(output.getvalue())
    return audio_id, len(chapters), sentence_timings


def get_audio_path(audio_id: str) -> Path:
    """Resolve an audio file by UUID, refusing arbitrary filesystem paths."""
    try:
        validated_id = str(uuid.UUID(audio_id))
    except ValueError as error:
        raise FileNotFoundError("Audio file not found.") from error

    path = OUTPUT_DIRECTORY / f"{validated_id}.wav"
    if not path.is_file():
        raise FileNotFoundError("Audio file not found.")
    return path
