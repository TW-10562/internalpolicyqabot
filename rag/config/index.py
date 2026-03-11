from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping

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
        self.config = self._validate(filled)
        self._apply_env_overrides()

    def reload(self) -> None:
        raw = self._read_yaml(self.config_file_path)
        filled = self._interpolate_placeholders(raw)
        self.config = self._validate(filled)
        self._apply_env_overrides()

    def findAndFillProjectRootDirTags(self) -> None:
        if isinstance(self.config, AppConfigSchema):
            data = self.config.model_dump(mode="python")
        else:
            data = dict(self.config)

        filled = self._interpolate_placeholders(data)
        self.config = self._validate(filled)
        self._apply_env_overrides()

    def _apply_env_overrides(self) -> None:
        def env_num(value: str | None, fallback: int) -> int:
            try:
                return int(value) if value is not None else fallback
            except (TypeError, ValueError):
                return fallback

        if os.getenv("SOLR_URL"):
            self.config.ApacheSolr.url = os.environ["SOLR_URL"]
        if os.getenv("SOLR_CORE_NAME"):
            self.config.ApacheSolr.coreName = os.environ["SOLR_CORE_NAME"]

        if os.getenv("RAG_BACKEND_HOST"):
            self.config.RAG.Backend.host = os.environ["RAG_BACKEND_HOST"]
        if os.getenv("RAG_BACKEND_PORT"):
            self.config.RAG.Backend.port = env_num(
                os.getenv("RAG_BACKEND_PORT"), self.config.RAG.Backend.port
            )
        backend_url = (
            os.getenv("RAG_BACKEND_URL")
            or os.getenv("RAG_API")
            or os.getenv("RAG_SERVICE_URL")
        )
        if backend_url:
            self.config.RAG.Backend.url = backend_url

        docs_root = os.getenv("DOCS_ROOT")
        if not docs_root:
            return
        upload_dir = os.getenv("UPLOAD_DIR", "files")
        uploads = self.config.RAG.Uploads
        uploads.rootDir = docs_root
        uploads.filesDir = str(Path(docs_root) / upload_dir)
        uploads.uploadDirectory = str(Path(docs_root) / "temp")

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
