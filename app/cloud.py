"""Everything hosted Offhook runs, in one process, for one Cloudflare container.

  * the API (``app.main``), as on any self-hosted install;
  * the call worker loop (``app.worker``), as a background task instead of its own
    process: it places queued calls and sends webhooks while the container is awake;
  * the website demo's voice server (``app.demo.server``), under ``/demo``.

``/_activity`` reports running calls; the Cloudflare Worker asks it before letting
the container sleep (see deploy/cloudflare). Run with
``uvicorn app.cloud:app --port 8080``.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi.responses import JSONResponse

from app import worker
from app.activity import active_calls
from app.demo.server import app as demo_app
from app.logger import logger
from app.main import app

app.mount("/demo", demo_app)

@app.get("/_activity", include_in_schema=False)
async def activity() -> JSONResponse:
    """Calls running in this process. The Worker blocks this path from the internet."""
    return JSONResponse({"calls": active_calls()})


# The API's own lifespan (key checks etc.) runs first; the worker starts inside it.
_api_lifespan = app.router.lifespan_context


@asynccontextmanager
async def _lifespan(a):  # noqa: ANN001 - the FastAPI app
    """Run the API's lifespan, with the call worker loop alongside it."""
    async with _api_lifespan(a):
        task = asyncio.create_task(worker.run())
        logger.info("[cloud] API, call worker and demo voice server running in one process")
        try:
            yield
        finally:
            worker._stop.set()  # let the loop finish its current item
            try:
                await asyncio.wait_for(task, timeout=20)
            except asyncio.TimeoutError:
                task.cancel()


app.router.lifespan_context = _lifespan
