import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.api.routes.audio import (
    AnalysisFeedbackRequest,
    AudioGenerationRequest,
    NarrationScriptLine,
    StoryAnalysisRequest,
    generate_audio,
    generate_narration_script,
    record_analysis_feedback,
)
from app.services.script_generation import VOICE_PROFILES, build_narration_script


class ScriptGenerationTests(unittest.TestCase):
    def test_builds_tagged_lines_without_rewriting_story_text(self) -> None:
        analysis = {
            "segments": [
                {
                    "text": 'Mira said, "Go now!"',
                    "speaker": "Mira",
                    "emotion": "afraid",
                    "is_dialogue": True,
                },
                {
                    "text": "The door opened quietly.",
                    "speaker": "Narrator",
                    "emotion": "neutral",
                    "is_dialogue": False,
                },
            ],
            "total_segments": 2,
            "truncated": False,
        }

        script = build_narration_script(analysis)
        mira_profile = script["lines"][0]["voice_profile"]

        self.assertIn(mira_profile, VOICE_PROFILES)
        self.assertEqual(
            script["lines"],
            [
                {
                    "number": 1,
                    "speaker": "Mira",
                    "delivery": "afraid",
                    "text": 'Mira said, "Go now!"',
                    "is_dialogue": True,
                    "voice_profile": mira_profile,
                },
                {
                    "number": 2,
                    "speaker": "Narrator",
                    "delivery": "neutral",
                    "text": "The door opened quietly.",
                    "is_dialogue": False,
                    "voice_profile": "gentle_female",
                },
            ],
        )
        self.assertEqual(script["total_lines"], 2)
        self.assertFalse(script["truncated"])

    def test_preserves_analysis_truncation_metadata(self) -> None:
        script = build_narration_script(
            {"segments": [], "total_segments": 251, "truncated": True}
        )

        self.assertEqual(script["lines"], [])
        self.assertEqual(script["total_lines"], 251)
        self.assertTrue(script["truncated"])

    def test_voice_profiles_are_stable_distinct_and_overrideable_per_book(self) -> None:
        analysis = {
            "segments": [
                {
                    "text": "Mira spoke.",
                    "speaker": "Mira",
                    "emotion": "neutral",
                    "is_dialogue": True,
                },
                {
                    "text": "Elara answered.",
                    "speaker": "Elara",
                    "emotion": "happy",
                    "is_dialogue": True,
                },
                {
                    "text": "Gideon smiled.",
                    "speaker": "Gideon",
                    "emotion": "warm",
                    "is_dialogue": False,
                },
                {
                    "text": "The door opened.",
                    "speaker": "Narrator",
                    "emotion": "neutral",
                    "is_dialogue": False,
                },
            ],
            "total_segments": 4,
            "truncated": False,
        }

        first = build_narration_script(analysis, "Lantern Gate")
        repeated = build_narration_script(analysis, "lantern gate")
        customized = build_narration_script(
            analysis,
            "Lantern Gate",
            {"Mira": "deep_male"},
        )
        narrator_customized = build_narration_script(
            analysis,
            "Lantern Gate",
            {"Narrator": "deep_male"},
        )
        voices = [line["voice_profile"] for line in first["lines"]]

        self.assertEqual(first, repeated)
        self.assertEqual(voices[3], "gentle_female")
        self.assertNotEqual(voices[0], voices[1])
        self.assertEqual(customized["lines"][0]["voice_profile"], "deep_male")
        self.assertNotIn(
            "deep_male",
            [
                line["voice_profile"]
                for line in narrator_customized["lines"]
                if line["speaker"] != "Narrator"
            ],
        )
        self.assertEqual(set(voices), set(VOICE_PROFILES))

    def test_api_generates_script_using_saved_book_feedback(self) -> None:
        analysis = {
            "segments": [
                {
                    "text": "The lantern flickered.",
                    "speaker": "Narrator",
                    "emotion": "afraid",
                    "is_dialogue": False,
                }
            ],
            "total_segments": 1,
            "truncated": False,
        }
        with (
            patch(
                "app.api.routes.audio.get_feedback",
                return_value={"speaker": {}, "voice_profile": {"Narrator": "deep_male"}},
            ) as feedback,
            patch("app.api.routes.audio.save_feedback") as save,
            patch(
                "app.api.routes.audio.analyze_story",
                return_value=analysis,
            ) as analyze,
        ):
            result = generate_narration_script(
                StoryAnalysisRequest(text="The lantern flickered.", book_id="Lantern")
            )

        feedback.assert_called_once_with("Lantern")
        analyze.assert_called_once_with(
            "The lantern flickered.",
            {"speaker": {}, "voice_profile": {"Narrator": "deep_male"}},
        )
        self.assertEqual(result.lines[0].speaker, "Narrator")
        self.assertEqual(result.lines[0].delivery, "afraid")
        self.assertEqual(result.lines[0].text, "The lantern flickered.")
        self.assertEqual(result.lines[0].voice_profile, "deep_male")
        save.assert_not_called()

    def test_api_persists_default_profiles_per_book_and_speaker(self) -> None:
        first_analysis = {
            "segments": [
                {
                    "text": "Elara waved.",
                    "speaker": "Elara",
                    "emotion": "happy",
                    "is_dialogue": True,
                },
                {
                    "text": "Mira smiled.",
                    "speaker": "Mira",
                    "emotion": "warm",
                    "is_dialogue": True,
                },
            ],
            "total_segments": 2,
            "truncated": False,
        }
        later_analysis = {
            "segments": [first_analysis["segments"][1]],
            "total_segments": 1,
            "truncated": False,
        }
        with tempfile.TemporaryDirectory() as data_directory:
            with (
                patch.dict(os.environ, {"STORYBOOK_DATA_DIR": data_directory}),
                patch(
                    "app.api.routes.audio.analyze_story",
                    side_effect=[first_analysis, later_analysis],
                ),
            ):
                first = generate_narration_script(
                    StoryAnalysisRequest(
                        text="Elara waved. Mira smiled.",
                        book_id="Lantern",
                    )
                )
                later = generate_narration_script(
                    StoryAnalysisRequest(text="Mira smiled.", book_id="Lantern")
                )

        first_profile = next(
            line.voice_profile for line in first.lines if line.speaker == "Mira"
        )
        self.assertEqual(later.lines[0].voice_profile, first_profile)

    def test_audio_generation_passes_script_voice_profiles_to_renderer(self) -> None:
        script_lines = [
            NarrationScriptLine(
                number=1,
                speaker="Mira",
                delivery="afraid",
                text="Mira spoke.",
                is_dialogue=True,
                voice_profile="deep_male",
            )
        ]
        request = AudioGenerationRequest(
            text="Mira spoke. The lantern glowed.",
            script_lines=script_lines,
        )

        with patch(
            "app.api.routes.audio.render_audio",
            return_value=("generated-id", 1, []),
        ) as render:
            response = generate_audio(request)

        render.assert_called_once_with(
            "Mira spoke. The lantern glowed.",
            1,
            "gentle",
            ["deep_male"],
            None,
        )
        self.assertEqual(response.chapters, 1)

    def test_audio_generation_passes_validated_chapter_plan_to_renderer(self) -> None:
        request = AudioGenerationRequest(
            text="Chapter One\nThe river widened.\nChapter Two\nThe boat drifted.",
            chapter_count=2,
            chapter_texts=[
                "Chapter One\nThe river widened.",
                "Chapter Two\nThe boat drifted.",
            ],
        )

        with patch(
            "app.api.routes.audio.render_audio",
            return_value=("generated-id", 2, []),
        ) as render:
            response = generate_audio(request)

        render.assert_called_once_with(
            request.text,
            2,
            "gentle",
            None,
            [1, 1],
        )
        self.assertEqual(response.chapters, 2)

    def test_audio_generation_rejects_chapter_plan_that_changes_story_text(self) -> None:
        request = AudioGenerationRequest(
            text="The river widened. The boat drifted.",
            chapter_count=2,
            chapter_texts=["The river widened.", "Someone else spoke."],
        )

        with self.assertRaisesRegex(HTTPException, "Chapter plan must preserve"):
            generate_audio(request)

    def test_audio_generation_rejects_plan_that_drops_headings(self) -> None:
        request = AudioGenerationRequest(
            text="Chapter One\nThe river widened.\nChapter Two\nThe boat drifted.",
            chapter_count=2,
            chapter_texts=["The river widened.", "The boat drifted."],
        )

        with self.assertRaisesRegex(HTTPException, "Chapter plan must preserve"):
            generate_audio(request)

    def test_audio_generation_rejects_script_that_does_not_match_story(self) -> None:
        request = AudioGenerationRequest(
            text="Mira spoke.",
            script_lines=[
                NarrationScriptLine(
                    number=1,
                    speaker="Mira",
                    delivery="afraid",
                    text="Someone else spoke.",
                    is_dialogue=True,
                    voice_profile="deep_male",
                )
            ],
        )

        with self.assertRaisesRegex(HTTPException, "beginning of the submitted story"):
            generate_audio(request)

    def test_voice_profile_feedback_is_validated_and_saved_per_speaker(self) -> None:
        request = AnalysisFeedbackRequest(
            book_id="Lantern",
            category="voice_profile",
            target_text="Mira",
            corrected_value="deep_male",
        )

        with (
            patch("app.api.routes.audio.save_feedback") as save,
        ):
            response = record_analysis_feedback(request)

        save.assert_called_once_with("Lantern", "voice_profile", "Mira", "deep_male")
        self.assertEqual(response.status, "saved")

        invalid_request = request.model_copy(update={"corrected_value": "unknown"})
        with self.assertRaisesRegex(HTTPException, "Unsupported voice profile"):
            record_analysis_feedback(invalid_request)


if __name__ == "__main__":
    unittest.main()
