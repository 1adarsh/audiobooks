from pathlib import Path
import subprocess
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.services.analysis_feedback import get_feedback, save_feedback
from app.services.audio_rendering import get_audio_path, render_audio
from app.services.character_casting import analyze_story

router = APIRouter(tags=["audio"])


class AudioGenerationRequest(BaseModel):
    text: str = Field(min_length=1, max_length=120_000)
    title: str = Field(default="storybook-audio", min_length=1, max_length=120)
    chapter_count: int = Field(default=1, ge=1, le=12)


class AudioGenerationResponse(BaseModel):
    audio_id: str
    title: str
    chapters: int
    audio_url: str
    download_url: str


class StoryAnalysisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=120_000)
    book_id: str = Field(default="default", min_length=1, max_length=120)


class DetectedCharacter(BaseModel):
    name: str
    mentions: int


class AnalyzedSegment(BaseModel):
    text: str
    speaker: str
    emotion: str
    emotion_confidence: float
    is_dialogue: bool


class MusicRecommendation(BaseModel):
    mood: str
    style: str
    intensity: str


class StoryAnalysisResponse(BaseModel):
    characters: list[DetectedCharacter]
    narrator_detected: bool
    segments: list[AnalyzedSegment]
    music: MusicRecommendation
    segments_analyzed: int
    total_segments: int
    truncated: bool


class AnalysisFeedbackRequest(BaseModel):
    book_id: str = Field(min_length=1, max_length=120)
    category: Literal["speaker", "emotion", "music_mood"]
    target_text: str = Field(default="", max_length=1_000)
    corrected_value: str = Field(min_length=1, max_length=120)


class AnalysisFeedbackResponse(BaseModel):
    status: str


@router.post("/audio/generate", response_model=AudioGenerationResponse)
def generate_audio(request: AudioGenerationRequest) -> AudioGenerationResponse:
    try:
        audio_id, chapter_total = render_audio(request.text, request.chapter_count)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail="Audio generation timed out.") from error
    except subprocess.CalledProcessError as error:
        raise HTTPException(
            status_code=500,
            detail="Local speech synthesis failed. Check that eSpeak is installed and working.",
        ) from error

    return AudioGenerationResponse(
        audio_id=audio_id,
        title=request.title.strip() or "storybook-audio",
        chapters=chapter_total,
        audio_url=f"/api/audio/{audio_id}",
        download_url=f"/api/audio/{audio_id}/download",
    )


@router.post("/audio/analyze", response_model=StoryAnalysisResponse)
def analyze_audio_story(request: StoryAnalysisRequest) -> StoryAnalysisResponse:
    if not request.text.strip():
        raise HTTPException(status_code=422, detail="Story text cannot be empty.")

    try:
        analysis = analyze_story(request.text, get_feedback(request.book_id))
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return StoryAnalysisResponse(**analysis)


@router.post("/audio/feedback", response_model=AnalysisFeedbackResponse)
def record_analysis_feedback(
    request: AnalysisFeedbackRequest,
) -> AnalysisFeedbackResponse:
    valid_emotions = {
        "neutral",
        "happy",
        "sad",
        "angry",
        "afraid",
        "curious",
        "excited",
        "warm",
    }
    valid_music_moods = {"calm", "wonder", "tense", "reflective", "mysterious", "joyful"}
    if request.category == "emotion" and request.corrected_value not in valid_emotions:
        raise HTTPException(status_code=422, detail="Unsupported emotion correction.")
    if request.category == "music_mood" and request.corrected_value not in valid_music_moods:
        raise HTTPException(status_code=422, detail="Unsupported music mood correction.")
    if request.category == "music_mood" and request.target_text:
        raise HTTPException(status_code=422, detail="Music mood feedback must not target text.")
    if request.category != "music_mood" and not request.target_text.strip():
        raise HTTPException(status_code=422, detail="Speaker and emotion feedback require target text.")

    try:
        save_feedback(
            request.book_id,
            request.category,
            request.target_text,
            request.corrected_value,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return AnalysisFeedbackResponse(status="saved")


def _audio_response(audio_id: str, download: bool) -> FileResponse:
    try:
        path: Path = get_audio_path(audio_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    return FileResponse(
        path,
        media_type="audio/wav",
        filename=f"{audio_id}.wav" if download else None,
    )


@router.get("/audio/{audio_id}")
def stream_audio(audio_id: str) -> FileResponse:
    return _audio_response(audio_id, download=False)


@router.get("/audio/{audio_id}/download")
def download_audio(audio_id: str) -> FileResponse:
    return _audio_response(audio_id, download=True)
