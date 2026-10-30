"""Optional OpenAI-compatible soundscape selector."""

import json
import os
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

VALID_MOODS = {"calm", "wonder", "tense", "reflective", "mysterious", "joyful"}
VALID_INTENSITIES = {"low", "medium", "high"}


def _configured_provider() -> tuple[str, str, str] | None:
    base_url = os.environ.get("STORYBOOK_AI_BASE_URL", "").strip()
    api_key = os.environ.get("STORYBOOK_AI_API_KEY", "").strip()
    model = os.environ.get("STORYBOOK_AI_MODEL", "").strip()
    if not any((base_url, api_key, model)):
        return None
    if not all((base_url, api_key, model)):
        raise RuntimeError(
            "Hosted AI requires STORYBOOK_AI_BASE_URL, STORYBOOK_AI_API_KEY, "
            "and STORYBOOK_AI_MODEL."
        )
    return base_url, api_key, model


def select_soundtrack_style(music: dict[str, str]) -> dict[str, str]:
    """Use a configured hosted chat-completions endpoint to refine a local cue."""
    provider = _configured_provider()
    if provider is None:
        return music

    base_url, api_key, model = provider
    body = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Refine the supplied audiobook background-music cue without changing "
                    "its mood. Return JSON with mood, style, and intensity. Keep the supplied "
                    "mood unchanged; intensity must be low, medium, or high. Do not include "
                    "lyrics or copyrighted song names."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(music),
            },
        ],
    }
    request = Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:
            response_body = json.loads(response.read())
        content = response_body["choices"][0]["message"]["content"]
        selection: Any = json.loads(content)
    except (URLError, TimeoutError) as error:
        raise RuntimeError("The configured hosted music selector request failed.") from error
    except (IndexError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError(
            "The configured hosted music selector returned an invalid response."
        ) from error

    if not isinstance(selection, dict):
        raise RuntimeError(
            "The configured hosted music selector returned an unsupported cue."
        )
    mood = selection.get("mood")
    style = selection.get("style")
    intensity = selection.get("intensity")
    if (
        not isinstance(mood, str)
        or mood not in VALID_MOODS
        or mood != music["mood"]
        or not isinstance(style, str)
        or not style.strip()
        or not isinstance(intensity, str)
        or intensity not in VALID_INTENSITIES
    ):
        raise RuntimeError(
            "The configured hosted music selector returned an unsupported cue."
        )
    return {
        "mood": mood,
        "style": style[:300],
        "intensity": intensity,
    }
