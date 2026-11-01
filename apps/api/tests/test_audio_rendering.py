import array
import io
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from app.services.audio_rendering import render_audio, split_sentences


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
    def test_sentence_splitting_keeps_quoted_sentence_boundaries(self) -> None:
        self.assertEqual(
            split_sentences('She said, "Wait!" Then she left.\nThe end.'),
            ['She said, "Wait!"', "Then she left.", "The end."],
        )

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
        self.assertEqual(args[args.index("-a") + 1], "100")

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
        self.assertEqual(args[args.index("-s") + 1], "165")

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
