"""Local WAV narration rendering using the system eSpeak executable."""

import array
import io
import re
import shutil
import subprocess
import tempfile
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path

from app.services.script_generation import VOICE_PROFILES

MAX_TEXT_LENGTH = 120_000
MAX_CHAPTERS = 12
OUTPUT_DIRECTORY = Path(tempfile.gettempdir()) / "storybook-audio"
SENTENCE_GAP_SECONDS = 0.12
CHAPTER_GAP_SECONDS = 0.6
SENTENCE_PATTERN = re.compile(r'[^.!?\n]+(?:[.!?]+(?:["”’])?|$)')


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


def _make_chapters(text: str, chapter_count: int) -> list[str]:
    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("Story text must contain at least one sentence.")

    count = min(chapter_count, len(sentences))
    chapters: list[str] = []
    for chapter_index in range(count):
        start = chapter_index * len(sentences) // count
        end = (chapter_index + 1) * len(sentences) // count
        chapters.append(" ".join(sentences[start:end]))
    return chapters


def render_audio(
    text: str,
    chapter_count: int,
    voice_style: str = "gentle",
    sentence_voice_profiles: list[str] | None = None,
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

    executable = shutil.which("espeak")
    if executable is None:
        raise RuntimeError(
            "eSpeak is required for local audio rendering. Install the system package 'espeak'."
        )

    chapters = _make_chapters(normalized_text, chapter_count)
    voice_options = (
        ["-v", "en-us+f3", "-s", "135", "-p", "46", "-a", "100"]
        if voice_style == "gentle"
        else ["-v", "en-us", "-s", "165", "-p", "50", "-a", "100"]
    )
    sentences = split_sentences(normalized_text)
    if sentence_voice_profiles is not None:
        if len(sentence_voice_profiles) > len(sentences):
            raise ValueError("Story has more voice profiles than sentences.")
        if any(profile not in VOICE_PROFILES for profile in sentence_voice_profiles):
            raise ValueError("Story contains an unsupported voice profile.")
    chapter_count_actual = len(chapters)
    chapter_ranges = [
        (
            chapter_index * len(sentences) // chapter_count_actual,
            (chapter_index + 1) * len(sentences) // chapter_count_actual,
        )
        for chapter_index in range(chapter_count_actual)
    ]

    audio_id = str(uuid.uuid4())
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIRECTORY / f"{audio_id}.wav"
    output = io.BytesIO()
    sentence_timings: list[SentenceTiming] = []
    with wave.open(output, "wb") as combined:
        sample_params: wave._wave_params | None = None
        written_frames = 0
        for sentence_index, sentence in enumerate(sentences):
            sentence_voice_options = voice_options
            if sentence_voice_profiles is not None and sentence_index < len(sentence_voice_profiles):
                profile = VOICE_PROFILES[sentence_voice_profiles[sentence_index]]
                sentence_voice_options = [
                    "-v",
                    profile["voice"],
                    "-s",
                    "135" if voice_style == "gentle" else "165",
                    "-p",
                    str(profile["pitch"]),
                    "-a",
                    "100",
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
