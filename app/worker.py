"""Background worker — drains the dial queue and the webhook delivery queue.

Run with: ``python -m app.worker``. Multiple instances are safe (claims use
``FOR UPDATE SKIP LOCKED``). Each item is claimed in its own short transaction
(lease), processed off-transaction (network I/O), then finalized in another
short transaction. Failures back off exponentially up to the item's
``max_attempts``; a per-provider circuit breaker avoids hammering a down
dependency. SIGTERM/SIGINT triggers a graceful drain-and-exit.
"""

from __future__ import annotations

import asyncio
import signal
import types
import uuid
from urllib.parse import urlparse

from app import queue
from app import telephony
from app.db.engine import session_scope
from app.db.models import Call, CallJob, WebhookDelivery, WebhookEndpoint
from app.logger import logger
from app.reliability import backoff_seconds, get_breaker
from app.settings import settings
from app.tenancy.resolve import voice_config_from_snapshot
from app.events import classify_error, emit_call_event
from app.webhooks.delivery import deliver

POLL_INTERVAL = 1.0
_stop = asyncio.Event()


def _lite(item) -> types.SimpleNamespace:
    """Detached snapshot of the queue columns we need after the session closes."""
    return types.SimpleNamespace(
        id=item.id, attempts=item.attempts, max_attempts=item.max_attempts
    )


# ---- dial jobs ----------------------------------------------------------


async def _process_dial(job_id: uuid.UUID, call_id: uuid.UUID) -> None:
    # Resolve creds + build the answer URL in one read txn. A resolution error
    # (missing/invalid connection) is permanent — fail the job, don't loop.
    # Resolution is a local DB read + decrypt, so it's safe to do before the
    # circuit-breaker check; the breaker only guards the external carrier dial.
    try:
        async with session_scope() as db:
            call = await db.get(Call, call_id)
            tenant_id = call.tenant_id
            snapshot = call.call_context_snapshot
            token = call.session_token
            to_number = call.to_number
            from_number = call.from_number
            voice_config = await voice_config_from_snapshot(db, tenant_id, snapshot, need_telephony=True)
    except Exception as exc:  # noqa: BLE001
        async with session_scope() as db:
            await queue.complete(db, CallJob, job_id, status="failed")
            call = await db.get(Call, call_id)
            if call is not None:
                call.status = "failed"
                call.error = f"resolution failed: {exc}"
                call.error_code = "config_error"
                await emit_call_event(db, call.tenant_id, call_id, "call.failed",
                                      {"status": "failed", "error": str(exc)}, error_code="config_error")
        logger.warning(f"[worker] dial resolution failed for call {call_id}: {exc}")
        return

    # Breaker is keyed on the actual provider so one carrier's outage can't trip
    # another's circuit.
    provider_name = voice_config.telephony.provider_name
    breaker = get_breaker(f"telephony:{provider_name}", fail_threshold=5, reset_timeout=30)
    if not breaker.allow():
        async with session_scope() as db:
            job = await db.get(CallJob, job_id)
            await queue.reschedule(db, CallJob, _lite(job), error="circuit open", delay_seconds=backoff_seconds(job.attempts))
        logger.warning(f"[worker] dial deferred: circuit open for {provider_name}")
        return

    base = (settings.public_base_url or "http://localhost:8000").rstrip("/")
    answer_url = f"{base}/v1/telephony/answer?session_token={token}"
    status_url = f"{base}/v1/telephony/status?session_token={token}"
    provider = telephony.get_provider(provider_name)

    try:
        provider_call_id = await provider.place_call(
            to=to_number, from_number=from_number, answer_url=answer_url,
            creds=voice_config.telephony, status_url=status_url,
        )
        breaker.record_success()
    except Exception as exc:  # noqa: BLE001 - dial errors are retryable
        breaker.record_failure()
        async with session_scope() as db:
            job = await db.get(CallJob, job_id)
            retried = await queue.reschedule(
                db, CallJob, _lite(job), error=str(exc), delay_seconds=backoff_seconds(job.attempts)
            )
            if not retried:
                code = classify_error(str(exc))
                call = await db.get(Call, call_id)
                call.status = "failed"
                call.error = str(exc)
                call.error_code = code
                await emit_call_event(db, tenant_id, call_id, "call.failed",
                                      {"status": "failed", "error": str(exc), "attempts": job.attempts},
                                      error_code=code)
        logger.warning(f"[worker] dial failed for call {call_id}: {exc}")
        return

    async with session_scope() as db:
        call = await db.get(Call, call_id)
        call.status = "dialing"
        call.provider_call_id = provider_call_id
        await emit_call_event(db, tenant_id, call_id, "call.dialing",
                              {"status": "dialing", "provider_call_id": provider_call_id})
        await queue.complete(db, CallJob, job_id)
    logger.info(f"[worker] dialed call {call_id} (provider_call_id={provider_call_id})")


# ---- webhook deliveries -------------------------------------------------


async def _process_delivery(delivery_id: uuid.UUID) -> None:
    async with session_scope() as db:
        delivery = await db.get(WebhookDelivery, delivery_id)
        endpoint = await db.get(WebhookEndpoint, delivery.endpoint_id) if delivery else None
        if delivery is None or endpoint is None or not endpoint.enabled:
            if delivery is not None:
                await queue.complete(db, WebhookDelivery, delivery_id, status="failed")
            return
        host = urlparse(endpoint.url).hostname or "webhook"
        breaker = get_breaker(f"webhook:{host}", fail_threshold=10, reset_timeout=30)
        if not breaker.allow():
            await queue.reschedule(db, WebhookDelivery, _lite(delivery),
                                   error="circuit open", delay_seconds=backoff_seconds(delivery.attempts))
            return
        result = await deliver(db, delivery, endpoint)
        if result.ok:
            breaker.record_success()
            delivery.response_code = result.status_code
            await queue.complete(db, WebhookDelivery, delivery_id, status="delivered")
            logger.info(f"[worker] webhook {delivery_id} delivered ({result.status_code})")
        else:
            breaker.record_failure()
            delivery.response_code = result.status_code
            retried = await queue.reschedule(
                db, WebhookDelivery, _lite(delivery),
                error=result.error or "delivery failed",
                delay_seconds=backoff_seconds(delivery.attempts),
            )
            logger.warning(f"[worker] webhook {delivery_id} failed ({result.error}); "
                           f"{'retrying' if retried else 'gave up'}")


# ---- loop ---------------------------------------------------------------


async def _claim_and_run() -> bool:
    """Claim+run one item from either queue. Returns True if something ran."""
    async with session_scope() as db:
        job = await queue.claim(db, CallJob)
        job_fields = (job.id, job.call_id) if job else None
    if job_fields:
        await _process_dial(*job_fields)
        return True

    async with session_scope() as db:
        delivery = await queue.claim(db, WebhookDelivery)
        delivery_id = delivery.id if delivery else None
    if delivery_id:
        await _process_delivery(delivery_id)
        return True
    return False


async def run() -> None:
    logger.info("[worker] started")
    while not _stop.is_set():
        try:
            ran = await _claim_and_run()
        except Exception:  # noqa: BLE001 - never let the loop die
            logger.exception("[worker] iteration error")
            ran = False
        if not ran:
            try:
                await asyncio.wait_for(_stop.wait(), timeout=POLL_INTERVAL)
            except asyncio.TimeoutError:
                pass
    logger.info("[worker] stopped")


def main() -> None:
    from dotenv import load_dotenv

    load_dotenv()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _stop.set)
    loop.run_until_complete(run())


if __name__ == "__main__":
    main()
