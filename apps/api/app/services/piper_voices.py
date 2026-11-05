"""Local Piper voice model paths and download configuration."""

from pathlib import Path

from app.services.ai_models import get_model_directory

PIPER_VOICE_DIRECTORY = "piper_voices"
PIPER_VOICE_REPOSITORY = "rhasspy/piper-voices"
PIPER_VOICE_REVISION = "b4e358ffcb232591bf73a540e70f7de528e4174a"

PIPER_VOICE_MODELS = {
    "gentle_female": "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    "bright_female": "en/en_US/amy/medium/en_US-amy-medium.onnx",
    "warm_male": "en/en_US/ryan/medium/en_US-ryan-medium.onnx",
    "deep_male": "en/en_US/norman/medium/en_US-norman-medium.onnx",
}


def get_piper_voice_path(profile: str) -> Path:
    model_relative_path = PIPER_VOICE_MODELS[profile]
    return get_model_directory() / PIPER_VOICE_DIRECTORY / model_relative_path
