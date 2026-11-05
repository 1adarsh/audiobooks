"""Chapter boundary detection and reader-configured chapter splitting."""

import re

from app.services.audio_rendering import split_sentences

MAX_CHAPTERS = 12

_CHAPTER_HEADING_RE = re.compile(
    r"^(?:#{1,6}\s*)?(?:chapter|part)\b"
    r"(?:\s+(?:[ivxlcdm]+|\d+|first|second|third|fourth|fifth|sixth|seventh|"
    r"eighth|ninth|tenth|eleventh|twelfth|one|two|three|four|five|six|seven|"
    r"eight|nine|ten|eleven|twelve)"
    r"(?:\s*[:.-]?\s*[A-Za-z0-9][A-Za-z0-9 ,':.-]{0,60})?"
    r"|\s*[:.-]\s*[A-Za-z0-9][A-Za-z0-9 ,':.-]{0,60})?$",
    re.IGNORECASE,
)


def _split_by_headings(text: str) -> list[tuple[str, list[str]]]:
    sections: list[tuple[str, list[str]]] = []
    heading = ""
    body_lines: list[str] = []
    found_heading = False

    def save_section() -> None:
        nonlocal body_lines
        if heading or body_lines:
            sections.append((heading, body_lines))
            body_lines = []

    for line in text.splitlines():
        normalized_line = line.strip()
        if _CHAPTER_HEADING_RE.match(normalized_line):
            save_section()
            heading = normalized_line
            found_heading = True
        elif normalized_line:
            body_lines.append(normalized_line)

    save_section()
    return sections if found_heading else []


def _split_evenly(text: str, chapter_count: int) -> list[str]:
    sentences = split_sentences(text)
    if not sentences:
        raise ValueError("Story text must contain at least one sentence.")

    count = min(max(1, chapter_count), len(sentences))
    return [
        " ".join(
            sentences[
                chapter_index * len(sentences) // count :
                (chapter_index + 1) * len(sentences) // count
            ]
        )
        for chapter_index in range(count)
    ]


def _format_section(heading: str, sentences: list[str]) -> str:
    if heading and sentences:
        return f"{heading}\n{' '.join(sentences)}"
    return " ".join(([heading] if heading else []) + sentences)


def _group_sections(
    sections: list[tuple[str, list[str]]],
    group_count: int,
) -> list[list[tuple[str, list[str]]]]:
    grouped_sections: list[list[tuple[str, list[str]]]] = []
    section_index = 0
    remaining_sentence_count = sum(len(sentences) for _, sentences in sections)

    for group_index in range(group_count - 1):
        groups_left = group_count - group_index
        max_section_index = len(sections) - groups_left + 1
        target_sentence_count = remaining_sentence_count / groups_left
        group_start = section_index
        group_sentence_count = 0

        while section_index < max_section_index:
            next_sentence_count = len(sections[section_index][1])
            if (
                section_index > group_start
                and abs(group_sentence_count - target_sentence_count)
                <= abs(
                    group_sentence_count
                    + next_sentence_count
                    - target_sentence_count
                )
            ):
                break

            group_sentence_count += next_sentence_count
            section_index += 1
            if group_sentence_count >= target_sentence_count:
                break

        grouped_sections.append(sections[group_start:section_index])
        remaining_sentence_count -= group_sentence_count

    grouped_sections.append(sections[section_index:])
    return grouped_sections


def split_story_into_chapters(
    text: str,
    chapter_count: int = 1,
    max_chapters: int = MAX_CHAPTERS,
) -> list[str]:
    """Return a chapter plan that preserves explicit headings when possible."""
    normalized_text = text.strip()
    if not normalized_text:
        raise ValueError("Story text cannot be empty.")
    if not 1 <= chapter_count <= max_chapters:
        raise ValueError(f"Chapter count must be between 1 and {max_chapters}.")

    sections = _split_by_headings(normalized_text)
    if not sections:
        return _split_evenly(normalized_text, chapter_count)

    section_sentences = [
        (heading, split_sentences(" ".join(body_lines)))
        for heading, body_lines in sections
    ]
    total_sentences = sum(len(sentences) for _, sentences in section_sentences)
    if not total_sentences:
        raise ValueError("Story text must contain at least one sentence.")

    target_count = min(chapter_count, total_sentences)
    if target_count <= len(section_sentences):
        chapters: list[str] = []
        for sections_in_chapter in _group_sections(section_sentences, target_count):
            chapters.append(
                " ".join(
                    _format_section(heading, sentences)
                    for heading, sentences in sections_in_chapter
                )
            )
        return chapters

    allocations = [1] * len(section_sentences)
    while sum(allocations) < target_count:
        splittable = [
            index
            for index, (_, sentences) in enumerate(section_sentences)
            if allocations[index] < len(sentences)
        ]
        section_index = max(
            splittable,
            key=lambda index: len(section_sentences[index][1]) / allocations[index],
        )
        allocations[section_index] += 1

    chapters = []
    for (heading, sentences), allocation in zip(section_sentences, allocations):
        for part_index in range(allocation):
            start = part_index * len(sentences) // allocation
            end = (part_index + 1) * len(sentences) // allocation
            chapters.append(
                _format_section(heading if part_index == 0 else "", sentences[start:end])
            )
    return chapters
