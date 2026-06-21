"""Application configuration loaded from environment / local config file."""

from __future__ import annotations

import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    """Return the default data directory.

    Priority:
    1. MIKO_DATA_DIR env var
    2. ~/.miko_prompt_studio on the current platform
    """
    env = os.environ.get("MIKO_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return Path.home() / ".miko_prompt_studio"


class Settings(BaseSettings):
    """Runtime settings for the backend.

    Most paths are derived from ``data_dir`` so that the Electron shell only
    needs to set a single environment variable.
    """

    model_config = SettingsConfigDict(
        env_prefix="MIKO_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Field(default_factory=_default_data_dir)

    # Database
    database_url: str = ""

    # API server
    host: str = "127.0.0.1"
    port: int = 21317

    # Security – master key for encrypting API keys at rest.
    # If empty, a derived key is stored in data_dir/master.key.
    secret_key: str = ""

    # CORS – the Electron renderer origin. ``*`` during development.
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])

    @property
    def db_path(self) -> Path:
        return self.data_dir / "miko.db"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def image_cache_dir(self) -> Path:
        return self.cache_dir / "preprocessed"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def effective_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{self.db_path.as_posix()}"

    @property
    def master_key_path(self) -> Path:
        return self.data_dir / "master.key"

    def ensure_dirs(self) -> None:
        """Create all required directories. Safe to call multiple times."""
        for d in (
            self.data_dir,
            self.cache_dir,
            self.image_cache_dir,
            self.uploads_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
        _settings.ensure_dirs()
    return _settings
