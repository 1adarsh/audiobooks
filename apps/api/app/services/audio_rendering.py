"""Local WAV narration rendering using the system eSpeak executable."""

import io
import shutil
import subprocess
import tempfile
import uuid
import wave
from pathlib import Path

MAX_TEXT_LENGTH = 120_000
MAX_CHAPTERS = 12
OUTPUT_DIRECTORY = Path(tempfile.gettempdir()) / "storybook-audio"


def _split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    current: list[str] = []

    for line in text.splitlines():
        stripped_line = line.strip()
        if not stripped_line:
            if current:
                sentences.append(" ".join(current))
                current = []
            continue

        fragments = stripped_line.replace("! ", "!\n").replace("? ", "?\n").replace(". ", ".\n")
        for fragment in fragments.splitlines():
            fragment = fragment.strip()
            if fragment:
                current.append(fragment)
                if fragment[-1] in ".!?":
                    sentences.append(" ".join(current))
                    current = []

    if current:
        sentences.append(" ".join(current))

    return sentences


def _make_chapters(text: str, chapter_count: int) -> list[str]:
    sentences = _split_sentences(text)
    if not sentences:
        raise ValueError("Story text must contain at least one sentence.")

    count = min(chapter_count, len(sentences))
    chapters: list[str] = []
    for chapter_index in range(count):
        start = chapter_index * len(sentences) // count
        end = (chapter_index + 1) * len(sentences) // count
        chapters.append(" ".join(sentences[start:end]))
    return chapters


def render_audio(text: str, chapter_count: int) -> tuple[str, int]:
    """Render a story to a combined WAV file and return its ID and chapter count."""
    normalized_text = text.strip()
    if not normalized_text:
        raise ValueError("Story text cannot be empty.")
    if len(normalized_text) > MAX_TEXT_LENGTH:
        raise ValueError(f"Story text must be {MAX_TEXT_LENGTH:,} characters or fewer.")
    if not 1 <= chapter_count <= MAX_CHAPTERS:
        raise ValueError(f"Chapter count must be between 1 and {MAX_CHAPTERS}.")

    executable = shutil.which("espeak")
    if executable is None:
        raise RuntimeError(
            "eSpeak is required for local audio rendering. Install the system package 'espeak'."
        )

    chapters = _make_chapters(normalized_text, chapter_count)
    rendered_wavs: list[bytes] = []
    for chapter in chapters:
        result = subprocess.run(
            [executable, "--stdout", "--stdin", "-v", "en-us", "-s", "165", "-p", "50"],
            input=chapter.encode("utf-8"),
            check=True,
            capture_output=True,
            timeout=180,
        )
        rendered_wavs.append(result.stdout)

    audio_id = str(uuid.uuid4())
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIRECTORY / f"{audio_id}.wav"
    output = io.BytesIO()

    with wave.open(output, "wb") as combined:
        sample_params: wave._wave_params | None = None
        for wav_data in rendered_wavs:
            with wave.open(io.BytesIO(wav_data), "rb") as chapter_audio:
                params = chapter_audio.getparams()
                if sample_params is None:
                    sample_params = params
                    combined.setparams(params)
                elif params[:4] != sample_params[:4]:
                    raise RuntimeError("Audio chapters have incompatible WAV formats.")
                combined.writeframes(chapter_audio.readframes(chapter_audio.getnframes()))
                silence_frames = int(params.framerate * 0.6)
                combined.writeframes(b"\x00" * silence_frames * params.nchannels * params.sampwidth)

    output_path.write_bytes(output.getvalue())
    return audio_id, len(chapters)


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
