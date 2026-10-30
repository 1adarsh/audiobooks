"""Download the small local models used for story analysis."""

from app.services.ai_models import EMOTION_MODEL_DIRECTORY, get_model_directory

EMOTION_MODEL_REPOSITORY = "Cohee/distilbert-base-uncased-go-emotions-onnx"
EMOTION_MODEL_REVISION = "d22488bc83be87678f12eee8a3f65a65de94ef85"


def download_models() -> None:
    try:
        import spacy
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError(
            "Install the AI dependencies first with 'pip install -e \".[ai]\"'."
        ) from error

    model_directory = get_model_directory()
    emotion_directory = model_directory / EMOTION_MODEL_DIRECTORY
    emotion_directory.mkdir(parents=True, exist_ok=True)

    snapshot_download(
        repo_id=EMOTION_MODEL_REPOSITORY,
        revision=EMOTION_MODEL_REVISION,
        local_dir=str(emotion_directory),
        allow_patterns=[
            "config.json",
            "onnx/model_quantized.onnx",
            "special_tokens_map.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "vocab.txt",
        ],
    )
    try:
        spacy.load("en_core_web_sm")
    except OSError:
        spacy.cli.download("en_core_web_sm")


if __name__ == "__main__":
    download_models()
