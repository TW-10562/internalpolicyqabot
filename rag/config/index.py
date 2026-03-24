from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

import yaml

from .schema import AppConfigSchema


class ConfigLoader:

    def __init__(
        self,
        config_file_path: Path | str | None = None,
        project_root_dir: Path | str | None = None,
    ):
        self.project_root_dir = (
            Path(project_root_dir).resolve()
            if project_root_dir
            else Path(__file__).resolve().parents[2]
        )
        self.config_file_path = (
            Path(config_file_path)
            if config_file_path
            else self.project_root_dir / "config" / "default.yml"
        )
        self._placeholders: dict[str, str] = {
            "<PROJECT_ROOT_DIR>": str(self.project_root_dir)
        }

        raw = self._read_yaml(self.config_file_path)
        filled = self._interpolate_placeholders(raw)
        validated = self._validate(filled)
        self.config = self._apply_env_overrides(validated)

    def reload(self) -> None:
        raw = self._read_yaml(self.config_file_path)
        filled = self._interpolate_placeholders(raw)
        validated = self._validate(filled)
        self.config = self._apply_env_overrides(validated)

    def findAndFillProjectRootDirTags(self) -> None:
        if isinstance(self.config, AppConfigSchema):
            data = self.config.model_dump(mode="python")
        else:
            data = dict(self.config)

        filled = self._interpolate_placeholders(data)
        validated = self._validate(filled)
        self.config = self._apply_env_overrides(validated)

    @staticmethod
    def _read_yaml(path: Path) -> dict[str, Any]:
        if not path.exists():
            raise FileNotFoundError(f"Config file not found: {path}")
        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            raise TypeError(f"YAML root must be a mapping: {path}")
        return data

    def _validate(self, data: dict[str, Any]) -> AppConfigSchema:
        try:
            return AppConfigSchema.model_validate(data)
        except Exception as e:
            raise ValueError(
                f"Error validating YAML config {self.config_file_path}: {e}"
            ) from e

    @staticmethod
    def _running_in_container() -> bool:
        return Path("/.dockerenv").exists()

    @staticmethod
    def _env_bool(name: str) -> bool | None:
        raw = str(os.getenv(name, "")).strip().lower()
        if not raw:
            return None
        if raw in {"1", "true", "yes", "on"}:
            return True
        if raw in {"0", "false", "no", "off"}:
            return False
        return None

    @staticmethod
    def _env_int(name: str) -> int | None:
        raw = str(os.getenv(name, "")).strip()
        if not raw:
            return None
        try:
            return int(raw)
        except ValueError:
            return None

    @staticmethod
    def _env_float(name: str) -> float | None:
        raw = str(os.getenv(name, "")).strip()
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    @staticmethod
    def _replace_local_service_host(value: str, service_name: str) -> str:
        host = str(value or "").strip()
        if host in {"localhost", "127.0.0.1", "::1"}:
            return service_name
        return host

    @staticmethod
    def _replace_local_service_url(
        value: str,
        service_name: str,
        default_port: int | None = None,
    ) -> str:
        raw = str(value or "").strip()
        if not raw:
            return raw

        parsed = urlsplit(raw)
        hostname = parsed.hostname or ""
        if hostname not in {"localhost", "127.0.0.1", "::1"}:
            return raw

        username = parsed.username or ""
        password = parsed.password or ""
        auth = username
        if password:
            auth = f"{auth}:{password}" if auth else f":{password}"

        port = parsed.port or default_port
        netloc = service_name
        if port:
            netloc = f"{netloc}:{port}"
        if auth:
            netloc = f"{auth}@{netloc}"

        return urlunsplit(
            (
                parsed.scheme or "http",
                netloc,
                parsed.path,
                parsed.query,
                parsed.fragment,
            )
        )

    def _apply_env_overrides(self, config: AppConfigSchema) -> AppConfigSchema:
        data = config.model_dump(mode="python")
        in_container = self._running_in_container()

        solr_url = os.getenv("SOLR_URL")
        if solr_url:
            data["ApacheSolr"]["url"] = solr_url
        elif in_container:
            data["ApacheSolr"]["url"] = self._replace_local_service_url(
                data["ApacheSolr"]["url"], "solr", 8983
            )

        solr_core_name = os.getenv("SOLR_CORE_NAME")
        if solr_core_name:
            data["ApacheSolr"]["coreName"] = solr_core_name

        if "Redis" in data:
            redis_host = os.getenv("REDIS_HOST")
            if redis_host:
                data["Redis"]["host"] = redis_host
            elif in_container:
                data["Redis"]["host"] = self._replace_local_service_host(
                    data["Redis"]["host"], "redis"
                )

            redis_port = self._env_int("REDIS_PORT")
            if redis_port is not None:
                data["Redis"]["port"] = redis_port

            redis_password = os.getenv("REDIS_PASSWORD")
            if redis_password:
                data["Redis"]["password"] = redis_password

            redis_database = self._env_int("REDIS_DB")
            if redis_database is not None:
                data["Redis"]["database"] = max(0, redis_database)

        if "Ollama" in data:
            ollama_base_url = os.getenv("OLLAMA_BASE_URL")
            if ollama_base_url:
                data["Ollama"]["url"] = [ollama_base_url]
            elif in_container and data.get("Ollama", {}).get("url"):
                data["Ollama"]["url"] = [
                    self._replace_local_service_url(url, "host.docker.internal", 11435)
                    for url in data["Ollama"]["url"]
                ]

        rag_backend_host = os.getenv("RAG_BACKEND_HOST")
        if rag_backend_host:
            data["RAG"]["Backend"]["host"] = rag_backend_host
        elif in_container:
            data["RAG"]["Backend"]["host"] = self._replace_local_service_host(
                data["RAG"]["Backend"]["host"], "rag-python"
            )

        rag_backend_port = self._env_int("RAG_BACKEND_PORT")
        if rag_backend_port is not None:
            data["RAG"]["Backend"]["port"] = rag_backend_port

        rag_backend_url = (
            os.getenv("RAG_BACKEND_URL")
            or os.getenv("RAG_API")
            or os.getenv("RAG_SERVICE_URL")
        )
        if rag_backend_url:
            data["RAG"]["Backend"]["url"] = rag_backend_url
        elif in_container:
            data["RAG"]["Backend"]["url"] = self._replace_local_service_url(
                data["RAG"]["Backend"]["url"], "rag-python", 8010
            )

        embedding_model = os.getenv("RAG_EMBEDDING_MODEL")
        if embedding_model:
            data["Models"]["ragEmbeddingModel"]["name"] = embedding_model

        rerank_model = os.getenv("RAG_RERANK_MODEL")
        if rerank_model:
            data["Models"]["ragRerankModel"]["name"] = rerank_model

        vector_only = self._env_bool("RAG_SEMANTIC_VECTOR_ONLY")
        if vector_only is not None:
            data["RAG"]["Retrieval"]["HybridSearch"]["vector_only"] = vector_only

        bm25_only = self._env_bool("RAG_SEMANTIC_BM25_ONLY")
        if bm25_only is not None:
            data["RAG"]["Retrieval"]["HybridSearch"]["bm25_only"] = bm25_only

        vector_weight = self._env_float("RAG_HYBRID_VECTOR_WEIGHT")
        if vector_weight is None:
            vector_weight = self._env_float("RAG_SEMANTIC_VECTOR_WEIGHT")
        if vector_weight is not None:
            data["RAG"]["Retrieval"]["HybridSearch"]["vector_weight"] = vector_weight

        bm25_weight = self._env_float("RAG_HYBRID_BM25_WEIGHT")
        if bm25_weight is None:
            bm25_weight = self._env_float("RAG_SEMANTIC_BM25_WEIGHT")
        if bm25_weight is not None:
            data["RAG"]["Retrieval"]["HybridSearch"]["bm25_weight"] = bm25_weight

        return self._validate(data)

    def _interpolate_placeholders(self, obj: Any) -> Any:
        if isinstance(obj, str):
            s = os.path.expanduser(os.path.expandvars(obj))
            for k, v in self._placeholders.items():
                if k in s:
                    s = s.replace(k, v)
            return s
        elif isinstance(obj, Mapping):
            return {k: self._interpolate_placeholders(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._interpolate_placeholders(x) for x in obj]
        else:
            return obj


configloader = ConfigLoader()
config = configloader.config
