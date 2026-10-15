"""FastAPI application — multi-tenant voice-calling service.

Router layout enforces auth structurally:
  * ``/v1`` tenant router has ``require_tenant`` as a router-level dependency,
    so every business route under it is authenticated by default.
  * The carrier router (Plivo webhooks) is mounted separately and authenticates
    via the single-use call ``session_token`` instead of an API key.
  * Health is public. The prebuilt dev UI is mounted only outside prod.
"""

from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import APIRouter, Depends, FastAPI  # noqa: E402

from app.api import (  # noqa: E402
    activity,
    agents,
    api_keys,
    connections,
    health,
    phone_numbers,
    tools,
    usage,
    webhooks,
)
from app.auth.dependencies import enforce_rate_limit, require_tenant  # noqa: E402
from app.crypto.keyprovider import get_key_provider  # noqa: E402
from app.logger import logger  # noqa: E402
from app.routes import carrier_router, tenant_router  # noqa: E402
from app.settings import settings  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail fast if the master key can't wrap/unwrap (prod) — otherwise warn.
    try:
        get_key_provider().self_test()  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        if settings.is_prod:
            raise
        logger.warning(f"[startup] master key self-test failed (dev): {exc}")
    logger.info(f"[startup] offhook up (env={settings.env})")
    yield


app = FastAPI(title="offhook", version="0.2.0", lifespan=lifespan)

# CORS for the dashboard (browser sends the API key as a Bearer header).
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Public health endpoints.
app.include_router(health.router)

# Tenant-authed /v1 surface — require_tenant applied at the router level.
v1 = APIRouter(prefix="/v1", dependencies=[Depends(require_tenant), Depends(enforce_rate_limit)])
v1.include_router(connections.router)
v1.include_router(agents.router)
v1.include_router(tools.router)
v1.include_router(api_keys.router)
v1.include_router(webhooks.router)
v1.include_router(usage.router)
v1.include_router(phone_numbers.router)
v1.include_router(activity.router)  # /v1/calls (list), /events, /transcript, /stats
v1.include_router(tenant_router)  # /v1/calls (create), /v1/providers
app.include_router(v1)

# Carrier webhooks (token-authed, NOT under require_tenant).
app.include_router(carrier_router, prefix="/v1")

# Dev-only playground UI (settings forbids this in prod).
if settings.enable_prebuilt_ui and not settings.is_prod:
    from app.prebuilt import mount_prebuilt

    mount_prebuilt(app)
    logger.info("[startup] prebuilt dev UI mounted at /client")
