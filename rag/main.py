import os
import socket
from pathlib import Path


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue

        value = value.strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in ("'", '"')
        ):
            value = value[1:-1]
        os.environ[key] = value


def _bootstrap_env() -> None:
    rag_dir = Path(__file__).resolve().parent
    project_root = rag_dir.parent
    for env_path in (
        rag_dir / ".env",
        project_root / ".env",
        project_root / ".env.shared",
    ):
        _load_env_file(env_path)


_bootstrap_env()

from config.index import config
import torch
import uvicorn
from services.gpu_guard import FORCE_GPU_ONLY, ensure_cuda_or_raise


def _is_running_in_container() -> bool:
    return Path("/.dockerenv").exists()


def _resolve_bind_host(configured_host: str) -> str:
    host = str(configured_host or "").strip() or "127.0.0.1"
    if host in {"0.0.0.0", "127.0.0.1", "localhost", "::", "::1"}:
        return host
    if _is_running_in_container():
        return host

    try:
        socket.getaddrinfo(host, None)
        return host
    except socket.gaierror:
        fallback_host = "127.0.0.1"
        print(
            f"[RAG] Bind host '{host}' is not resolvable on this machine. "
            f"Falling back to {fallback_host}. "
            "Set RAG_BACKEND_HOST to override."
        )
        return fallback_host


def _resolve_bind_port(configured_port: int) -> int:
    raw_port = os.getenv("RAG_BACKEND_PORT")
    if raw_port is None:
        return configured_port
    try:
        return int(raw_port)
    except ValueError:
        return configured_port

if __name__ == "__main__":
    ensure_cuda_or_raise("rag-api-startup")
    if FORCE_GPU_ONLY:
        gpu_name = torch.cuda.get_device_name(0)
        print(f"[RAG] GPU-only mode enabled. Using CUDA device: {gpu_name}")
    bind_host = _resolve_bind_host(
        os.getenv("RAG_BACKEND_HOST") or config.RAG.Backend.host
    )
    bind_port = _resolve_bind_port(config.RAG.Backend.port)
    uvicorn.run(
        "api.main:app",
        host=bind_host,
        port=bind_port,
        reload=True,
        reload_dirs=[str(Path(__file__).resolve().parent)],
    )
