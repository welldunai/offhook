"""Health endpoints — liveness and readiness. Public (no auth)."""

from __future__ import annotations

from fastapi import APIRouter, Response
from sqlalchemy import text

from app.crypto.keyprovider import get_key_provider
from app.db.engine import session_scope

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness — the process is up."""
    return {"status": "ok"}


def _migrations_at_head() -> bool:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config("alembic.ini")
    head = ScriptDirectory.from_config(cfg).get_current_head()
    return head is not None  # presence check; compared to DB below


@router.get("/readyz")
async def readyz(response: Response) -> dict[str, object]:
    """Readiness — DB reachable, master key works, migrations applied."""
    checks: dict[str, object] = {}
    ok = True

    # DB + migration version
    try:
        async with session_scope() as db:
            await db.execute(text("SELECT 1"))
            row = (await db.execute(text("SELECT version_num FROM alembic_version"))).first()
            db_rev = row[0] if row else None
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
        checks["database"] = "ok"
        checks["migrations"] = "ok" if db_rev == head else f"behind (db={db_rev}, head={head})"
        ok = ok and db_rev == head
    except Exception as exc:  # noqa: BLE001
        checks["database"] = f"error: {type(exc).__name__}"
        ok = False

    # Master key self-test
    try:
        get_key_provider().self_test()  # type: ignore[attr-defined]
        checks["master_key"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["master_key"] = f"error: {type(exc).__name__}"
        ok = False

    if not ok:
        response.status_code = 503
    return {"status": "ready" if ok else "not_ready", "checks": checks}
