import unittest

from app.api.routes.audio import StoryChapterPlanRequest, suggest_story_chapters
from app.services.audio_rendering import split_sentences
from app.services.chaptering import split_story_into_chapters


class ChapteringTests(unittest.TestCase):
    def test_prefers_explicit_chapter_headings_when_present(self) -> None:
        story = (
            "Chapter One\nThe river widened. The boat drifted.\n\n"
            "Chapter Two\nThe lantern glowed. The guard woke."
        )

        chapters = split_story_into_chapters(story, 2)

        self.assertEqual(len(chapters), 2)
        self.assertIn("Chapter One", chapters[0])
        self.assertIn("Chapter Two", chapters[1])

    def test_detects_headings_separated_by_single_newlines(self) -> None:
        story = "Chapter One: The River\nThe river widened.\nChapter Two: The Boat\nThe boat drifted."

        chapters = split_story_into_chapters(story, 2)

        self.assertIn("Chapter One: The River", chapters[0])
        self.assertIn("Chapter Two: The Boat", chapters[1])

    def test_does_not_treat_regular_prose_as_a_chapter_heading(self) -> None:
        story = "Part of the story begins. The travelers start walking."

        chapters = split_story_into_chapters(story, 2)

        self.assertEqual(chapters, ["Part of the story begins.", "The travelers start walking."])

    def test_groups_extra_explicit_chapters_to_match_requested_count(self) -> None:
        story = (
            "Chapter One\nThe river widened.\n\n"
            "Chapter Two\nThe boat drifted.\n\n"
            "Chapter Three\nThe lantern glowed."
        )

        chapters = split_story_into_chapters(story, 2)

        self.assertEqual(len(chapters), 2)
        combined = " ".join(chapters)
        self.assertIn("Chapter One", combined)
        self.assertIn("Chapter Two", combined)
        self.assertIn("Chapter Three", combined)

    def test_groups_explicit_chapters_by_sentence_weight(self) -> None:
        story = (
            "Chapter One\nA begins.\n\n"
            "Chapter Two\nB begins.\n\n"
            "Chapter Three\nC begins.\n\n"
            "Chapter Four\n"
            "D begins. E continues. F continues. G continues. "
            "H continues. I continues. J continues. K ends."
        )

        chapters = split_story_into_chapters(story, 2)

        self.assertEqual(len(chapters), 2)
        self.assertEqual(len(split_sentences(chapters[0])), 3)
        self.assertEqual(len(split_sentences(chapters[1])), 8)

    def test_splits_explicit_chapters_up_to_requested_count(self) -> None:
        story = (
            "Chapter One\nThe river widened. The boat drifted.\n\n"
            "Chapter Two\nThe lantern glowed. The guard woke."
        )

        chapters = split_story_into_chapters(story, 3)

        self.assertEqual(len(chapters), 3)
        self.assertIn("Chapter One", chapters[0])
        self.assertIn("Chapter Two", chapters[2])

    def test_balances_long_text_across_requested_chapters(self) -> None:
        story = " ".join(f"Sentence {index}." for index in range(1, 9))

        chapters = split_story_into_chapters(story, 3)

        self.assertEqual(len(chapters), 3)
        self.assertEqual(
            sum(len([sentence for sentence in chapter.split(".") if sentence.strip()]) for chapter in chapters),
            8,
        )

    def test_rejects_empty_story(self) -> None:
        with self.assertRaisesRegex(ValueError, "Story text cannot be empty"):
            split_story_into_chapters("   ")

    def test_api_returns_the_suggested_chapter_count_and_content(self) -> None:
        response = suggest_story_chapters(
            StoryChapterPlanRequest(
                text="Chapter One\nThe river widened.\nChapter Two\nThe boat drifted.",
                chapter_count=2,
            )
        )

        self.assertEqual(response.chapter_count, 2)
        self.assertEqual(len(response.chapters), 2)
        self.assertIn("The river widened.", response.chapters[0])
        self.assertIn("The boat drifted.", response.chapters[1])


if __name__ == "__main__":
    unittest.main()
