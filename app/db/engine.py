"""Async SQLAlchemy engine + session management.

One engine per process (connection pool). ``get_session`` is the FastAPI
dependency that yields a request-scoped ``AsyncSession`` and commits/rolls back
around the request. ``session_scope`` is the equivalent for non-request code
(workers, the seed CLI).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.settings import settings

_engine: AsyncEngine = create_async_engine(
    settings.database_url,
    pool_pre_ping=True,  # drop dead connections instead of erroring mid-request
    pool_size=10,
    max_overflow=20,
)

_sessionmaker: async_sessionmaker[AsyncSession] = async_sessionmaker(
    _engine, expire_on_commit=False, autoflush=False
)


def get_engine() -> AsyncEngine:
    return _engine


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Transactional session for non-request code. Commits on success."""
    async with _sessionmaker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: request-scoped session, committed on clean return."""
    async with _sessionmaker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
