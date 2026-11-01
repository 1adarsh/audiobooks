"""Build a narration script from analyzed story segments."""

import hashlib
from typing import TypedDict


class VoiceProfile(TypedDict):
    label: str
    voice: str
    pitch: int


VOICE_PROFILES: dict[str, VoiceProfile] = {
    "gentle_female": {
        "label": "Gentle female",
        "voice": "en-us+f3",
        "pitch": 46,
    },
    "bright_female": {
        "label": "Bright female",
        "voice": "en-us+f2",
        "pitch": 58,
    },
    "warm_male": {
        "label": "Warm male",
        "voice": "en-us+m2",
        "pitch": 42,
    },
    "deep_male": {
        "label": "Deep male",
        "voice": "en-us+m3",
        "pitch": 34,
    },
}


class ScriptLine(TypedDict):
    number: int
    speaker: str
    delivery: str
    text: str
    is_dialogue: bool
    voice_profile: str


def build_narration_script(
    analysis: dict[str, object],
    book_id: str = "default",
    saved_voice_profiles: dict[str, str] | None = None,
) -> dict[str, object]:
    """Format analyzed segments as speaker- and delivery-tagged script lines."""
    segments = analysis["segments"]
    if not isinstance(segments, list):
        raise ValueError("Story analysis did not return valid segments.")

    saved_voice_profiles = saved_voice_profiles or {}
    speakers = sorted(
        {
            str(segment["speaker"])
            for segment in segments
            if isinstance(segment, dict) and str(segment["speaker"]).casefold() != "narrator"
        },
        key=str.casefold,
    )
    narrator_profile = saved_voice_profiles.get("Narrator", "gentle_female")
    character_profiles = [
        profile_id for profile_id in VOICE_PROFILES if profile_id != narrator_profile
    ]
    book_digest = hashlib.sha256(book_id.strip().casefold().encode("utf-8")).digest()
    profile_offset = int.from_bytes(book_digest[:4], "big") % len(character_profiles)
    default_profiles = {
        speaker: character_profiles[(index + profile_offset) % len(character_profiles)]
        for index, speaker in enumerate(speakers)
    }

    lines: list[ScriptLine] = []
    for index, segment in enumerate(segments, start=1):
        if not isinstance(segment, dict):
            raise ValueError("Story analysis returned an invalid segment.")
        speaker = str(segment["speaker"])
        default_profile = (
            "gentle_female"
            if speaker.casefold() == "narrator"
            else default_profiles[speaker]
        )
        lines.append(
            {
                "number": index,
                "speaker": speaker,
                "delivery": str(segment["emotion"]),
                "text": str(segment["text"]),
                "is_dialogue": bool(segment["is_dialogue"]),
                "voice_profile": saved_voice_profiles.get(speaker, default_profile),
            }
        )

    return {
        "lines": lines,
        "total_lines": analysis["total_segments"],
        "truncated": analysis["truncated"],
    }
