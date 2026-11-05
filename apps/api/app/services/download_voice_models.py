"""Download local neural narration voices."""

from app.services.ai_models import get_model_directory
from app.services.piper_voices import (
    PIPER_VOICE_DIRECTORY,
    PIPER_VOICE_MODELS,
    PIPER_VOICE_REPOSITORY,
    PIPER_VOICE_REVISION,
)


def download_voice_models() -> None:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError(
            "Neural voice dependencies are missing. Install the API with "
            "'pip install -e \".[neural-voice]\"'."
        ) from error

    model_directory = get_model_directory() / PIPER_VOICE_DIRECTORY
    model_directory.mkdir(parents=True, exist_ok=True)
    allow_patterns = [
        pattern
        for model_path in PIPER_VOICE_MODELS.values()
        for pattern in (model_path, f"{model_path}.json")
    ]
    snapshot_download(
        repo_id=PIPER_VOICE_REPOSITORY,
        revision=PIPER_VOICE_REVISION,
        local_dir=str(model_directory),
        allow_patterns=allow_patterns,
    )


if __name__ == "__main__":
    download_voice_models()
