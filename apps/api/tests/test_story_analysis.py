import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.services.analysis_feedback import get_feedback, save_feedback
from app.services.character_casting import (
    _emotion_name,
    _music_recommendation,
    _speaker_for_sentence,
    analyze_story,
)
from app.services.hosted_music import select_soundtrack_style


class FakeEntity:
    def __init__(self, text: str, label: str) -> None:
        self.text = text
        self.label_ = label


class FakeDocument:
    def __init__(self, entities: list[FakeEntity]) -> None:
        self.ents = entities


class StoryAnalysisTests(unittest.TestCase):
    def test_speaker_attribution_uses_named_character_and_narrator(self) -> None:
        self.assertEqual(
            _speaker_for_sentence('Mira said, "Go now!"', ["Mira"]),
            "Mira",
        )
        self.assertEqual(
            _speaker_for_sentence("The door opened quietly.", ["Mira"]),
            "Narrator",
        )
        self.assertEqual(
            _speaker_for_sentence('"Go now!"', ["Mira"]),
            "Unidentified speaker",
        )

    def test_emotion_mapping_and_music_choice(self) -> None:
        self.assertEqual(_emotion_name("nervousness"), "afraid")
        self.assertEqual(_emotion_name("joy"), "happy")
        self.assertEqual(_music_recommendation(["afraid"])["mood"], "tense")
        self.assertEqual(_music_recommendation(["curious"])["mood"], "wonder")

    def test_analysis_applies_saved_line_and_music_corrections(self) -> None:
        text = 'Mira said, "Go now!" The door opened quietly.'
        fake_nlp = lambda _: FakeDocument([FakeEntity("Mira", "PERSON")])
        corrections = {
            "speaker": {'Mira said, "Go now!"': "Narrator"},
            "emotion": {},
            "music_mood": {"": "reflective"},
        }
        with (
            patch(
                "app.services.character_casting.load_models",
                return_value=(fake_nlp, None, None, []),
            ),
            patch(
                "app.services.character_casting._emotion_scores",
                return_value=[("fear", 0.8), ("neutral", 0.7)],
            ),
            patch(
                "app.services.character_casting.select_soundtrack_style",
                side_effect=lambda music: music,
            ),
        ):
            result = analyze_story(text, corrections)

        self.assertEqual(result["characters"], [{"name": "Mira", "mentions": 1}])
        self.assertEqual(result["segments"][0]["speaker"], "Narrator")
        self.assertEqual(result["music"]["mood"], "reflective")
        self.assertIn("piano", result["music"]["style"])

    def test_feedback_is_saved_and_latest_value_is_reused_per_book(self) -> None:
        with tempfile.TemporaryDirectory() as data_directory:
            with patch.dict(os.environ, {"STORYBOOK_DATA_DIR": data_directory}):
                save_feedback(" The Lantern Gate ", "music_mood", "", "wonder")
                save_feedback("the lantern gate", "music_mood", "", "reflective")
                save_feedback("the lantern gate", "voice_profile", "Mira", "deep_male")
                save_feedback("another book", "music_mood", "", "tense")

                corrections = get_feedback("THE LANTERN GATE")
                other_book = get_feedback("another book")
                saved_database = Path(data_directory) / "feedback.sqlite3"
                self.assertTrue(saved_database.is_file())

        self.assertEqual(corrections["music_mood"][""], "reflective")
        self.assertEqual(corrections["voice_profile"]["Mira"], "deep_male")
        self.assertEqual(other_book["music_mood"][""], "tense")

    def test_hosted_selector_stays_local_when_not_configured(self) -> None:
        music = {"mood": "calm", "style": "soft strings", "intensity": "low"}
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(select_soundtrack_style(music), music)

    def test_partial_hosted_configuration_is_reported(self) -> None:
        with patch.dict(
            os.environ,
            {"STORYBOOK_AI_BASE_URL": "https://example.invalid/v1"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "requires STORYBOOK_AI_BASE_URL"):
                select_soundtrack_style(
                    {"mood": "calm", "style": "soft strings", "intensity": "low"}
                )


if __name__ == "__main__":
    unittest.main()
