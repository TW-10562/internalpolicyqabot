import os

import torch


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


# Default ON per DGX deployment requirement.
FORCE_GPU_ONLY = _env_bool("RAG_FORCE_GPU_ONLY", True)


def ensure_cuda_or_raise(component: str) -> None:
    if not FORCE_GPU_ONLY:
        return
    if not torch.cuda.is_available() or torch.cuda.device_count() <= 0:
        raise RuntimeError(
            f"[{component}] GPU-only mode is enabled but CUDA GPU is unavailable. "
            "Set RAG_FORCE_GPU_ONLY=0 only for local debugging."
        )

