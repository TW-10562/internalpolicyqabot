import os
import sys
from pathlib import Path

from loguru import logger

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

logger.remove()

logger.add(
    sys.stdout,
    level="DEBUG",
    enqueue=False,  # Avoid multiprocessing semaphore requirement in restricted envs
    backtrace=True,  # Show full stack trace on exceptions
    diagnose=True,  # Show detailed debug information (recommended in development)
)

try:
    _log_file = LOG_DIR / "rag_{time:YYYYMMDD}.log"
    # Quick writability check — the directory may be owned by root after a
    # container run or sudo invocation.
    if os.access(LOG_DIR, os.W_OK):
        logger.add(
            _log_file,
            rotation="10 MB",
            retention="7 days",
            encoding="utf-8",
        )
    else:
        _fallback = Path("/tmp/rag_logs")
        _fallback.mkdir(exist_ok=True)
        logger.add(
            _fallback / "rag_{time:YYYYMMDD}.log",
            rotation="10 MB",
            retention="7 days",
            encoding="utf-8",
        )
        logger.warning(f"Log dir {LOG_DIR} not writable, falling back to {_fallback}")
except PermissionError:
    logger.warning(f"Cannot write to log dir {LOG_DIR}, file logging disabled")

__all__ = ["logger"]
