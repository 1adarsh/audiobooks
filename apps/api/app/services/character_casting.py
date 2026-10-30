"""Character detection and per-book voice assignment."""

import re
from collections import Counter
from typing import Any

from app.services.ai_models import load_models
from app.services.hosted_music import select_soundtrack_style

MAX_ANALYZED_SEGMENTS = 250
SPEECH_VERBS = (
    "said",
    "asked",
    "replied",
    "shouted",
    "whispered",
    "cried",
    "called",
    "answered",
    "muttered",
    "exclaimed",
)
MUSIC_STYLES = {
    "calm": ("subtle ambient pads with sparse acoustic textures", "low"),
    "wonder": ("light celesta, plucked strings, and airy orchestral textures", "medium"),
    "tense": ("low strings, soft percussion, and restrained drones", "medium"),
    "reflective": ("gentle piano and warm sustained strings", "low"),
    "mysterious": ("muted low strings, sparse bell tones, and soft drones", "low"),
    "joyful": ("bright pizzicato strings and light rhythmic percussion", "medium"),
}


def _sentences(text: str) -> list[str]:
    sentences: list[str] = []
    current: list[str] = []
    index = 0
    while index < len(text):
        character = text[index]
        if character == "\n":
            sentence = "".join(current).strip()
            if sentence:
                sentences.append(sentence)
            current = []
            index += 1
            continue

        current.append(character)
        if character in ".!?":
            end = index + 1
            while end < len(text) and text[end] in "\"”’":
                current.append(text[end])
                end += 1
            if end == len(text) or text[end].isspace():
                sentence = "".join(current).strip()
                if sentence:
                    sentences.append(sentence)
                current = []
                index = end
                continue
        index += 1

    sentence = "".join(current).strip()
    if sentence:
        sentences.append(sentence)
    return sentences


def _emotion_name(label: str) -> str:
    if label in {"amusement", "joy", "love", "optimism", "pride", "relief"}:
        return "happy"
    if label in {"anger", "annoyance", "disapproval"}:
        return "angry"
    if label in {"fear", "nervousness"}:
        return "afraid"
    if label in {"sadness", "grief", "disappointment", "remorse"}:
        return "sad"
    if label in {"curiosity", "confusion", "realization"}:
        return "curious"
    if label in {"excitement", "surprise"}:
        return "excited"
    if label in {"caring", "gratitude", "admiration", "approval"}:
        return "warm"
    return "neutral"


def _emotion_scores(texts: list[str]) -> list[tuple[str, float]]:
    if not texts:
        return []

    import numpy as np

    _, tokenizer, session, labels = load_models()
    encodings = tokenizer.encode_batch(texts)
    input_arrays = {
        "input_ids": np.asarray([encoding.ids for encoding in encodings]),
        "attention_mask": np.asarray([encoding.attention_mask for encoding in encodings]),
        "token_type_ids": np.zeros(
            (len(encodings), len(encodings[0].ids)),
            dtype=np.int64,
        ),
    }

    model_inputs: dict[str, Any] = {}
    for model_input in session.get_inputs():
        values = input_arrays.get(model_input.name)
        if values is None:
            raise RuntimeError(
                f"The configured emotion model has an unsupported input: {model_input.name}."
            )
        if model_input.type == "tensor(int32)":
            values = values.astype(np.int32)
        model_inputs[model_input.name] = values

    results: list[tuple[str, float]] = []
    for offset in range(0, len(texts), 16):
        batch_inputs = {
            name: values[offset : offset + 16]
            for name, values in model_inputs.items()
        }
        logits = session.run(None, batch_inputs)[0]
        probabilities = np.exp(logits - np.max(logits, axis=1, keepdims=True))
        probabilities /= probabilities.sum(axis=1, keepdims=True)
        for scores in probabilities:
            best_index = int(np.argmax(scores))
            results.append((labels[best_index], float(scores[best_index])))
    return results


def _quoted(text: str) -> bool:
    return any(mark in text for mark in ('"', "“", "”", "‘", "’"))


def _speaker_for_sentence(sentence: str, character_names: list[str]) -> str:
    if not _quoted(sentence):
        return "Narrator"

    verbs = "|".join(SPEECH_VERBS)
    for name in character_names:
        escaped_name = re.escape(name)
        if re.search(rf"\b{escaped_name}\s+(?:{verbs})\b", sentence, re.IGNORECASE):
            return name
        if re.search(rf"\b(?:{verbs})\s+{escaped_name}\b", sentence, re.IGNORECASE):
            return name
    return "Unidentified speaker"


def _music_recommendation(emotions: list[str]) -> dict[str, str]:
    counts = Counter(emotions)
    dominant_emotion = counts.most_common(1)[0][0] if counts else "neutral"
    if dominant_emotion in {"afraid", "angry"}:
        mood = "tense"
    elif dominant_emotion in {"sad", "warm"}:
        mood = "reflective"
    elif dominant_emotion in {"curious", "excited"}:
        mood = "wonder"
    else:
        mood = "calm"
    style, intensity = MUSIC_STYLES[mood]
    return {"mood": mood, "style": style, "intensity": intensity}


def analyze_story(text: str, corrections: dict[str, dict[str, str]]) -> dict[str, object]:
    nlp, _, _, _ = load_models()
    document = nlp(text)
    character_counts = Counter(
        entity.text.strip()
        for entity in document.ents
        if entity.label_ == "PERSON" and entity.text.strip()
    )
    character_names = list(character_counts)
    sentences = _sentences(text)
    analyzed_sentences = sentences[:MAX_ANALYZED_SEGMENTS]
    emotion_results = _emotion_scores(analyzed_sentences)

    segments: list[dict[str, object]] = []
    for sentence, (model_emotion, confidence) in zip(
        analyzed_sentences,
        emotion_results,
        strict=True,
    ):
        speaker = _speaker_for_sentence(sentence, character_names)
        emotion = _emotion_name(model_emotion)
        speaker = corrections.get("speaker", {}).get(sentence, speaker)
        emotion = corrections.get("emotion", {}).get(sentence, emotion)
        segments.append(
            {
                "text": sentence,
                "speaker": speaker,
                "emotion": emotion,
                "emotion_confidence": confidence,
                "is_dialogue": _quoted(sentence),
            }
        )

    detected_emotions = [str(segment["emotion"]) for segment in segments]
    music = _music_recommendation(detected_emotions)
    saved_music_mood = corrections.get("music_mood", {}).get("", "")
    if saved_music_mood:
        style, intensity = MUSIC_STYLES[saved_music_mood]
        music = {
            "mood": saved_music_mood,
            "style": style,
            "intensity": intensity,
        }
    music = select_soundtrack_style(music)

    return {
        "characters": [
            {"name": name, "mentions": count}
            for name, count in character_counts.most_common()
        ],
        "narrator_detected": any(not bool(segment["is_dialogue"]) for segment in segments),
        "segments": segments,
        "music": music,
        "segments_analyzed": len(segments),
        "total_segments": len(sentences),
        "truncated": len(sentences) > len(segments),
    }
