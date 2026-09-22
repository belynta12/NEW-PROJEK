"""
Avatar AI Lifetime - versi Pipecat AI (opsional).

Pakai ini kalau Anda ingin percakapan super-responsif dengan interupsi natural
(barge-in): pengunjung bisa memotong ucapan avatar seperti telepon sungguhan.
Audio dikirim lewat WebRTC, jadi latensinya jauh lebih rendah daripada
pendekatan minta-jawab biasa.

Alur pipeline:
    mic (WebRTC) -> Silero VAD -> STT -> LLM -> TTS (suara kloning Anda) -> speaker

Gerakan wajah:
  - Cara termurah: biarkan halaman web utama (mode puppet di ../public) yang
    menganimasikan foto, lalu gerakkan mulut dari amplitudo audio keluar.
  - Cara termirip manusia: aktifkan layanan avatar realtime (Simli/HeyGen)
    dengan menyalakan blok VIDEO di bawah.

Jalankan:
    cd pipecat
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp ../.env .env          # pakai API key yang sama
    python bot.py

Lalu buka URL yang tercetak di terminal (klien WebRTC bawaan Pipecat).
"""

import os

from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams

load_dotenv()

# ---------------------------------------------------------------------------
# Persona: sama semangatnya dengan versi Node (folder ../knowledge)
# ---------------------------------------------------------------------------


def load_knowledge() -> str:
    folder = os.path.join(os.path.dirname(__file__), "..", "knowledge")
    parts = []
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            if name.lower().endswith((".md", ".txt")):
                with open(os.path.join(folder, name), encoding="utf-8") as handle:
                    parts.append(f"[{name}]\n{handle.read()}")
    return "\n\n---\n\n".join(parts)[:8000]


PERSONA_NAME = os.getenv("PERSONA_NAME", "Avatar Saya")
SYSTEM_PROMPT = f"""Kamu adalah "{PERSONA_NAME}", avatar digital yang berbicara langsung sebagai orang tersebut (pakai kata "saya").

ATURAN (jawabanmu diucapkan dengan suara, bukan dibaca):
1. Maksimal tiga kalimat, padat dan jelas.
2. Jangan pakai markdown, bullet, simbol, atau emoji.
3. Bahasa default Bahasa Indonesia; ikuti bahasa pengguna bila berbeda.
4. Pertanyaan umum boleh dijawab dengan pengetahuanmu.
5. Fakta pribadi hanya dari DATA PRIBADI di bawah. Kalau tidak ada, katakan terus terang.

DATA PRIBADI:
{load_knowledge()}
"""


async def run_bot(transport):
    # --- STT: pilih salah satu -------------------------------------------
    if os.getenv("DEEPGRAM_API_KEY"):
        from pipecat.services.deepgram.stt import DeepgramSTTService
        from deepgram import LiveOptions

        stt = DeepgramSTTService(
            api_key=os.getenv("DEEPGRAM_API_KEY"),
            live_options=LiveOptions(model="nova-2", language="id", smart_format=True),
        )
    else:
        # Groq Whisper: paling murah (~$0.04 per jam audio)
        from pipecat.services.groq.stt import GroqSTTService

        stt = GroqSTTService(
            api_key=os.getenv("GROQ_API_KEY"),
            model="whisper-large-v3-turbo",
            language="id",
        )

    # --- LLM: endpoint OpenAI-compatible (Groq default, sangat cepat) ----
    llm = OpenAILLMService(
        api_key=os.getenv("GROQ_API_KEY") or os.getenv("OPENAI_API_KEY"),
        base_url=os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
        model=os.getenv("LLM_MODEL", "llama-3.3-70b-versatile"),
    )

    # --- TTS: suara kloning Anda ----------------------------------------
    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID"),
        model=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
    )

    context = OpenAILLMContext([{"role": "system", "content": SYSTEM_PROMPT}])
    context_aggregator = llm.create_context_aggregator(context)

    stages = [
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
    ]

    # --- VIDEO (opsional): avatar realtime -------------------------------
    # Aktifkan salah satu bila ingin lipsync sekelas HeyGen.
    #
    # from pipecat.services.simli.video import SimliVideoService
    # from simli import SimliConfig
    # stages.append(SimliVideoService(SimliConfig(
    #     os.getenv("SIMLI_API_KEY"), os.getenv("SIMLI_FACE_ID"))))
    #
    # from pipecat.services.heygen.video import HeyGenVideoService
    # stages.append(HeyGenVideoService(
    #     api_key=os.getenv("HEYGEN_API_KEY"),
    #     avatar_id=os.getenv("HEYGEN_AVATAR_ID")))

    stages += [transport.output(), context_aggregator.assistant()]

    task = PipelineTask(
        Pipeline(stages),
        params=PipelineParams(
            allow_interruptions=True,  # pengunjung boleh memotong ucapan avatar
            enable_metrics=True,
        ),
    )

    runner = PipelineRunner()
    logger.info("Avatar siap. Bicara saja, avatar akan menjawab.")
    await runner.run(task)


async def main():
    """Transport WebRTC lokal: tidak perlu akun layanan pihak ketiga."""
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

    transport = SmallWebRTCTransport(
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            video_out_enabled=False,  # jadikan True bila memakai layanan avatar video
            vad_analyzer=SileroVADAnalyzer(),
        )
    )
    await run_bot(transport)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
