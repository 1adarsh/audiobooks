from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.audio import router as audio_router
from app.api.routes.health import router as health_router

app = FastAPI(
    title="Storybook Audio API",
    description="Backend for local story analysis and chapter audio generation.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8081",
        "http://127.0.0.1:8081",
        "http://localhost:19006",
        "http://127.0.0.1:19006",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

app.include_router(health_router, prefix="/api")
app.include_router(audio_router, prefix="/api")
