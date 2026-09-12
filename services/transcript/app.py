import re

from fastapi import FastAPI, HTTPException, Query
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    InvalidVideoId,
    IpBlocked,
    NoTranscriptFound,
    PoTokenRequired,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    VideoUnplayable,
    YouTubeRequestFailed,
)

app = FastAPI(title="Syllabot Transcript Service", version="1.0.0")
VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
transcript_api = YouTubeTranscriptApi()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/transcript")
def get_transcript(
    video_id: str = Query(..., alias="videoId"),
    languages: str = Query("es,en"),
):
    if not VIDEO_ID_PATTERN.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="videoId inválido")
    language_preferences = [language.strip() for language in languages.split(",") if language.strip()]
    try:
        available = transcript_api.list(video_id)
        try:
            selected = available.find_transcript(language_preferences)
        except NoTranscriptFound:
            # Un subtítulo en otra variante regional sigue siendo evidencia útil.
            selected = next(iter(available), None)
            if selected is None:
                raise
        transcript = selected.fetch()
        segments = transcript.to_raw_data()
    except InvalidVideoId as error:
        raise HTTPException(status_code=400, detail={"code": "invalid_video_id", "message": "videoId inválido"}) from error
    except (TranscriptsDisabled, NoTranscriptFound) as error:
        raise HTTPException(status_code=404, detail={"code": "no_transcript", "message": "El video no ofrece subtítulos públicos"}) from error
    except (VideoUnavailable, VideoUnplayable) as error:
        raise HTTPException(status_code=404, detail={"code": "video_unavailable", "message": "El video no está disponible"}) from error
    except (IpBlocked, RequestBlocked, PoTokenRequired) as error:
        raise HTTPException(status_code=503, detail={"code": "youtube_blocked", "message": "YouTube bloqueó temporalmente la extracción"}) from error
    except YouTubeRequestFailed as error:
        if "429" in str(error):
            raise HTTPException(status_code=503, detail={"code": "youtube_rate_limited", "message": "YouTube limitó las solicitudes de subtítulos"}) from error
        raise HTTPException(status_code=502, detail={"code": "transcript_upstream_error", "message": "Falló el proveedor de subtítulos"}) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail={"code": "transcript_upstream_error", "message": "Falló el proveedor de subtítulos"}) from error
    return {
        "videoId": video_id,
        "language": transcript.language_code,
        "isGenerated": transcript.is_generated,
        "segments": segments,
        "text": " ".join(segment["text"] for segment in segments),
    }
