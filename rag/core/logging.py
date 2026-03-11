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

logger.add(
    LOG_DIR / "rag_{time:YYYYMMDD}.log",
    rotation="10 MB",
    retention="7 days",
    encoding="utf-8",
)

__all__ = ["logger"]
