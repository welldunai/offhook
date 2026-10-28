"""DATABASE_URL accepts the plain Postgres URL Neon (and most hosts) hand out."""

import pytest

from app.settings import to_asyncpg_url


@pytest.mark.parametrize(
    "given, expected",
    [
        ("postgresql://u:p@ep-x.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
         "postgresql+asyncpg://u:p@ep-x.aws.neon.tech/neondb?ssl=require"),
        ("postgres://u:p@host:5432/db?sslmode=verify-full", "postgresql+asyncpg://u:p@host:5432/db?ssl=require"),
        ("postgresql://u:p@host/db", "postgresql+asyncpg://u:p@host/db"),
        ("postgresql+asyncpg://voice:voice@localhost:5432/voice", "postgresql+asyncpg://voice:voice@localhost:5432/voice"),
        ("postgresql://u:p@host/db?sslmode=disable&application_name=offhook", "postgresql+asyncpg://u:p@host/db?application_name=offhook"),
        ("sqlite+aiosqlite:///x.db", "sqlite+aiosqlite:///x.db"),
    ],
)
def test_to_asyncpg_url(given, expected):
    assert to_asyncpg_url(given) == expected
