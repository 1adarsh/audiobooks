"""Load the optional local NLP and emotion models."""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


EMOTION_MODEL_DIRECTORY = "go_emotions_onnx"


def get_model_directory() -> Path:
    configured_directory = os.environ.get("STORYBOOK_MODEL_DIR")
    if configured_directory:
        return Path(configured_directory).expanduser()
    return Path.home() / ".cache" / "storybook-audio" / "models"


@lru_cache(maxsize=1)
def load_models() -> tuple[Any, Any, Any, list[str]]:
    """Return spaCy NER, tokenizer, ONNX session, and model labels."""
    emotion_directory = get_model_directory() / EMOTION_MODEL_DIRECTORY
    onnx_path = emotion_directory / "onnx" / "model_quantized.onnx"
    config_path = emotion_directory / "config.json"
    tokenizer_path = emotion_directory / "tokenizer.json"

    missing_paths = [
        path for path in (onnx_path, config_path, tokenizer_path) if not path.is_file()
    ]
    if missing_paths:
        raise RuntimeError(
            "Local AI models are missing. Run "
            "'python -m app.services.download_models' from apps/api."
        )

    try:
        import onnxruntime
        import spacy
        from tokenizers import Tokenizer
    except ImportError as error:
        raise RuntimeError(
            "AI dependencies are missing. Install the API with 'pip install -e \".[ai]\"'."
        ) from error

    try:
        nlp = spacy.load("en_core_web_sm")
    except OSError as error:
        raise RuntimeError(
            "The spaCy English model is missing. Run "
            "'python -m app.services.download_models' from apps/api."
        ) from error

    try:
        with config_path.open(encoding="utf-8") as model_config:
            config = json.load(model_config)
        labels = [
            config["id2label"][str(index)]
            for index in range(len(config["id2label"]))
        ]
        tokenizer = Tokenizer.from_file(str(tokenizer_path))
        tokenizer.enable_truncation(max_length=128)
        tokenizer.enable_padding(length=128, pad_id=0, pad_token="[PAD]")
        session_options = onnxruntime.SessionOptions()
        session_options.intra_op_num_threads = min(os.cpu_count() or 1, 2)
        session = onnxruntime.InferenceSession(
            str(onnx_path),
            sess_options=session_options,
            providers=["CPUExecutionProvider"],
        )
    except (KeyError, OSError, ValueError) as error:
        raise RuntimeError(f"Unable to initialize the local AI models: {error}") from error

    return nlp, tokenizer, session, labels
