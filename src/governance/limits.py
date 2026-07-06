"""API-level governance guards.

Wire these into src/api.py route decorators via FastAPI dependencies:

    from fastapi import Depends
    from src.governance import payload_size_guard, run_admission_guard, run_slots

    @app.post("/run", status_code=202,
              dependencies=[Depends(payload_size_guard), Depends(run_admission_guard)])
    async def enqueue_run(request: RunRequest):
        ...

And hold a run slot for the duration of background execution:

    async def _execute_run_background(...):
        async with run_slots:
            await run_hivemind(...)

All limits are env-var configurable, matching the repo's HIVEMIND_* convention.
Set HIVEMIND_GOVERNANCE_ENABLED=0 to turn every guard into a no-op.
"""

import asyncio
import os

from fastapi import HTTPException, Request

# ---------------------------------------------------------------------------
# Config (env-var driven, matching existing HIVEMIND_* convention)
# ---------------------------------------------------------------------------

GOVERNANCE_ENABLED = os.getenv("HIVEMIND_GOVERNANCE_ENABLED", "1") == "1"
MAX_BODY_BYTES = int(os.getenv("HIVEMIND_MAX_BODY_BYTES", "1000000"))  # 1 MB
MAX_CONCURRENT_RUNS = int(os.getenv("HIVEMIND_MAX_CONCURRENT_RUNS", "5"))


# ---------------------------------------------------------------------------
# Concurrent run slots
# ---------------------------------------------------------------------------

class RunSlots:
    """Tracks concurrent run capacity.

    Two-part design:
      * ``run_admission_guard`` calls :meth:`available` at request time and
        rejects with 429 when the system is saturated (fast feedback to the
        client, before any work is enqueued).
      * The background executor wraps the actual run in ``async with run_slots``
        so a slot is held for the run's full duration and always released,
        even on exceptions. This is leak-proof; the admission check is
        advisory (a tiny race between check and acquire is acceptable — the
        worst case is one extra run briefly queuing on the semaphore).
    """

    def __init__(self, max_slots: int) -> None:
        self._max = max_slots
        self._semaphore = asyncio.Semaphore(max_slots)
        self._in_flight = 0
        self._lock = asyncio.Lock()

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def available(self) -> bool:
        return self._in_flight < self._max

    async def __aenter__(self) -> "RunSlots":
        await self._semaphore.acquire()
        async with self._lock:
            self._in_flight += 1
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        async with self._lock:
            self._in_flight -= 1
        self._semaphore.release()


run_slots = RunSlots(MAX_CONCURRENT_RUNS)


# ---------------------------------------------------------------------------
# FastAPI dependency guards
# ---------------------------------------------------------------------------

async def run_admission_guard() -> None:
    """Reject new runs with 429 when concurrent-run capacity is exhausted."""
    if not GOVERNANCE_ENABLED:
        return
    if not run_slots.available():
        raise HTTPException(
            status_code=429,
            detail=(
                f"Too many concurrent runs "
                f"({run_slots.in_flight}/{MAX_CONCURRENT_RUNS}). Retry later."
            ),
        )


async def payload_size_guard(request: Request) -> None:
    """Reject oversized request bodies with 413.

    Checks Content-Length first (cheap), but does NOT trust its absence:
    if the header is missing, the body is read directly and measured.
    Starlette caches ``request.body()``, so the endpoint can still parse
    the same body afterwards without re-reading the stream.
    """
    if not GOVERNANCE_ENABLED:
        return

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_BODY_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Payload exceeds {MAX_BODY_BYTES} bytes.",
                )
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length header.")

    # Header absent or unverifiable: measure the actual body.
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Payload exceeds {MAX_BODY_BYTES} bytes.",
        )