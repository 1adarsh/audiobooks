import array
import io
import os
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from app.services.audio_rendering import (
    CHAPTER_GAP_SECONDS,
    SENTENCE_GAP_SECONDS,
    _make_chapters,
    render_audio,
    split_sentences,
)


def make_wav() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16_000)
        samples = array.array("h", [1200, -1200] * 800)
        audio.writeframes(samples.tobytes())
    return output.getvalue()


class AudioRenderingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine_environment = patch.dict(os.environ, {"STORYBOOK_TTS_ENGINE": "espeak"})
        self.engine_environment.start()
        self.addCleanup(self.engine_environment.stop)

    def test_sentence_splitting_keeps_quoted_sentence_boundaries(self) -> None:
        self.assertEqual(
            split_sentences('She said, "Wait!" Then she left.\nThe end.'),
            ['She said, "Wait!"', "Then she left.", "The end."],
        )

    def test_custom_chapter_sentence_counts_preserve_requested_boundaries(self) -> None:
        self.assertEqual(
            _make_chapters(
                "The river widened. The boat drifted. The lantern glowed.",
                2,
                [1, 2],
            ),
            ["The river widened.", "The boat drifted. The lantern glowed."],
        )

    def test_custom_chapter_boundaries_get_longer_audio_pauses(self) -> None:
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=make_wav(), stderr=b"")
        with tempfile.TemporaryDirectory() as output_directory:
            with (
                patch("app.services.audio_rendering.shutil.which", return_value="/usr/bin/espeak"),
                patch("app.services.audio_rendering.subprocess.run", return_value=result),
                patch(
                    "app.services.audio_rendering.OUTPUT_DIRECTORY",
                    Path(output_directory),
                ),
            ):
                _, chapters, timings = render_audio(
                    "First sentence. Second sentence. Third sentence.",
                    2,
                    chapter_sentence_counts=[1, 2],
                )

        self.assertEqual(chapters, 2)
        chapter_pause = timings[1].start - timings[0].end
        sentence_pause = timings[2].start - timings[1].end
        self.assertAlmostEqual(chapter_pause, CHAPTER_GAP_SECONDS, delta=0.01)
        self.assertAlmostEqual(sentence_pause, SENTENCE_GAP_SECONDS, delta=0.01)

    def test_default_voice_style_is_gentle(self) -> None:
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=make_wav(), stderr=b"")
        with tempfile.TemporaryDirectory() as output_directory:
            with (
                patch("app.services.audio_rendering.shutil.which", return_value="/usr/bin/espeak"),
                patch("app.services.audio_rendering.subprocess.run", return_value=result) as run,
                patch(
                    "app.services.audio_rendering.OUTPUT_DIRECTORY",
                    Path(output_directory),
                ),
            ):
                render_audio("A little story.", 1)

        args = run.call_args.args[0]
        self.assertEqual(args[args.index("-v") + 1], "en-us+f3")
        self.assertEqual(args[args.index("-s") + 1], "135")
        self.assertEqual(args[args.index("-p") + 1], "46")
        self.assertEqual(args[args.index("-a") + 1], "80")

    def test_expressive_voice_is_available_on_request(self) -> None:
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=make_wav(), stderr=b"")
        with tempfile.TemporaryDirectory() as output_directory:
            with (
                patch("app.services.audio_rendering.shutil.which", return_value="/usr/bin/espeak"),
                patch("app.services.audio_rendering.subprocess.run", return_value=result) as run,
                patch(
                    "app.services.audio_rendering.OUTPUT_DIRECTORY",
                    Path(output_directory),
                ),
            ):
                render_audio("A little story.", 1, "expressive")

        args = run.call_args.args[0]
        self.assertEqual(args[args.index("-v") + 1], "en-us")
        self.assertEqual(args[args.index("-s") + 1], "155")

    def test_script_voice_profiles_are_applied_per_sentence(self) -> None:
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=make_wav(), stderr=b"")
        with tempfile.TemporaryDirectory() as output_directory:
            with (
                patch("app.services.audio_rendering.shutil.which", return_value="/usr/bin/espeak"),
                patch("app.services.audio_rendering.subprocess.run", return_value=result) as run,
                patch(
                    "app.services.audio_rendering.OUTPUT_DIRECTORY",
                    Path(output_directory),
                ),
            ):
                render_audio(
                    "A little story. Another sentence.",
                    1,
                    sentence_voice_profiles=["deep_male"],
                )

        first_args = run.call_args_list[0].args[0]
        second_args = run.call_args_list[1].args[0]
        self.assertEqual(first_args[first_args.index("-v") + 1], "en-us+m3")
        self.assertEqual(first_args[first_args.index("-p") + 1], "34")
        self.assertEqual(second_args[second_args.index("-v") + 1], "en-us+f3")

    def test_rejects_unknown_voice_style(self) -> None:
        with self.assertRaisesRegex(ValueError, "Voice style must be"):
            render_audio("A little story.", 1, "unknown")

    def test_neural_engine_uses_local_synthesizer_without_espeak(self) -> None:
        with tempfile.TemporaryDirectory() as output_directory:
            with (
                patch.dict(os.environ, {"STORYBOOK_TTS_ENGINE": "neural"}),
                patch("app.services.audio_rendering.shutil.which") as which,
                patch(
                    "app.services.audio_rendering._synthesize_with_piper",
                    return_value=make_wav(),
                ) as synthesize,
                patch(
                    "app.services.audio_rendering.OUTPUT_DIRECTORY",
                    Path(output_directory),
                ),
            ):
                audio_id, chapters, timings = render_audio("A little story.", 1)

            which.assert_not_called()
            synthesize.assert_called_once_with("A little story.", "gentle_female", "gentle")
            self.assertEqual(chapters, 1)
            self.assertEqual(len(timings), 1)
            self.assertTrue((Path(output_directory) / f"{audio_id}.wav").is_file())

    def test_audio_has_valid_duration_and_sentence_word_timings(self) -> None:
        result = subprocess.CompletedProcess(args=[], returncode=0, stdout=make_wav(), stderr=b"")
        with tempfile.TemporaryDirectory() as output_directory:
            with (
                patch("app.services.audio_rendering.shutil.which", return_value="/usr/bin/espeak"),
                patch("app.services.audio_rendering.subprocess.run", return_value=result),
                patch(
                    "app.services.audio_rendering.OUTPUT_DIRECTORY",
                    Path(output_directory),
                ),
            ):
                audio_id, chapters, timings = render_audio(
                    "A little story. This is another sentence.", 1
                )

            with wave.open(str(Path(output_directory) / f"{audio_id}.wav"), "rb") as audio:
                pcm = audio.readframes(audio.getnframes())
                self.assertGreater(audio.getnframes(), 0)
                self.assertEqual(
                    len(pcm),
                    audio.getnframes() * audio.getnchannels() * audio.getsampwidth(),
                )
                self.assertGreater(max(abs(sample) for sample in array.array("h", pcm)), 0)
                self.assertLess(audio.getnframes() / audio.getframerate(), 10)

        self.assertEqual(chapters, 1)
        self.assertEqual(
            [timing.text for timing in timings],
            ["A little story.", "This is another sentence."],
        )
        self.assertLess(timings[0].start, timings[0].end)
        self.assertLess(timings[0].end, timings[1].start)
        self.assertEqual(len(timings[1].word_starts), 4)
        self.assertEqual(sorted(timings[1].word_starts), timings[1].word_starts)


if __name__ == "__main__":
    unittest.main()
