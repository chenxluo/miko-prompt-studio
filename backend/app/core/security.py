"""API key storage using Fernet symmetric encryption.

The master key is stored in ``data_dir/master.key`` (generated on first use).
API keys are encrypted at rest and stored in the settings table.

This is the simplified MVP approach.  System keychain integration is a
later phase (see 设计文档 section 13).
"""

from __future__ import annotations

import contextlib
import secrets

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.settings import SettingORM

# ---------------------------------------------------------------------------
# Master key management
# ---------------------------------------------------------------------------

def _load_or_create_master_key() -> bytes:
    """Load the master encryption key, creating it if it doesn't exist."""
    settings = get_settings()
    key_path = settings.master_key_path

    if key_path.exists():
        return key_path.read_bytes()

    # Generate a new key and persist it.
    key = Fernet.generate_key()
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key)
    # On POSIX, restrict permissions. On Windows the file inherits user perms.
    with contextlib.suppress(OSError):
        key_path.chmod(0o600)
    return key


_fernet: Fernet | None = None


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_master_key())
    return _fernet


def encrypt_value(plaintext: str) -> str:
    """Encrypt a string and return a base64 ciphertext string."""
    return get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_value(ciphertext: str) -> str:
    """Decrypt a ciphertext string. Raises ValueError on failure."""
    try:
        return get_fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("Failed to decrypt value — master key may have changed") from exc


# ---------------------------------------------------------------------------
# API key CRUD
# ---------------------------------------------------------------------------

async def store_api_key(db: AsyncSession, provider_id: str, api_key: str) -> None:
    """Store (or update) an API key for a provider, encrypted at rest."""
    encrypted = encrypt_value(api_key)
    stmt = select(SettingORM).where(SettingORM.key == f"api_key:{provider_id}")
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()

    if row is None:
        row = SettingORM(
            key=f"api_key:{provider_id}",
            value=encrypted,
            category="api_key",
        )
        db.add(row)
    else:
        row.value = encrypted
        row.updated_at = _now_iso()

    await db.flush()


async def get_api_key(db: AsyncSession, provider_id: str) -> str | None:
    """Retrieve and decrypt an API key. Returns None if not stored."""
    stmt = select(SettingORM).where(SettingORM.key == f"api_key:{provider_id}")
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()
    if row is None or not row.value:
        return None
    return decrypt_value(row.value)


async def list_api_key_providers(db: AsyncSession) -> list[str]:
    """Return a list of provider IDs that have stored API keys."""
    stmt = select(SettingORM.key).where(SettingORM.category == "api_key")
    result = await db.execute(stmt)
    return [row[0].removeprefix("api_key:") for row in result.all()]


async def delete_api_key(db: AsyncSession, provider_id: str) -> bool:
    """Delete a stored API key. Returns True if a key was deleted."""
    stmt = select(SettingORM).where(SettingORM.key == f"api_key:{provider_id}")
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()
    if row is None:
        return False
    await db.delete(row)
    await db.flush()
    return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def mask_api_key(key: str) -> str:
    """Return a masked version of an API key for UI display.

    e.g. ``sk-abcdefghijklmnop1234567890`` → ``sk-a...7890``
    """
    if not key:
        return ""
    if len(key) <= 8:
        return key[:2] + "..." if len(key) > 2 else "***"
    return key[:4] + "..." + key[-4:]


def generate_random_key(length: int = 32) -> str:
    """Generate a random key (for IDs, tokens, etc.)."""
    return secrets.token_urlsafe(length)


def _now_iso() -> str:
    from app.schemas.common import utc_now
    return utc_now().isoformat()
