"""Bounded, drainable desktop worker using upstream command execution.

One worker per vault is enforced by the native workspace lock. Unlike upstream's
LIVE-query worker, queued work is only claimed when a slot is available, so
shutdown and cancellation do not leave unbounded pending asyncio tasks.
"""
import asyncio
import os
from pathlib import Path

import commands  # Registers the pinned upstream commands.
from open_notebook.database.repository import ensure_record_id, repo_query
from surreal_commands.core.service import command_service


DEFAULT_CONCURRENCY = 2
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 8


def worker_concurrency() -> int:
    """Parallel-job cap from PRISM_WORKER_CONCURRENCY (Settings > System >
    Worker Queue). Absent/invalid values fall back to the default so queue
    behavior never breaks."""
    try:
        n = int(os.environ.get("PRISM_WORKER_CONCURRENCY", DEFAULT_CONCURRENCY))
    except (TypeError, ValueError):
        return DEFAULT_CONCURRENCY
    return max(MIN_CONCURRENCY, min(MAX_CONCURRENCY, n))


async def run():
    drain = Path(os.environ["PRISM_NOTEBOOK_DATA"], ".drain")
    drain.unlink(missing_ok=True)
    # The previous supervisor no longer owns this workspace. Never silently
    # rerun interrupted billable jobs; surface them for an explicit retry.
    await repo_query("UPDATE command SET status = 'failed', error_message = 'Interrupted when Prism closed. Retry this source or podcast.' WHERE status = 'running'")
    concurrency = worker_concurrency()
    active: dict[str, asyncio.Task] = {}
    while True:
        for job_id, task in list(active.items()):
            if task.done():
                if not task.cancelled():
                    task.exception()  # Retrieve failures; executor persists details.
                del active[job_id]
            else:
                rows = await repo_query("SELECT status FROM $id", {"id": ensure_record_id(job_id)})
                if rows and rows[0].get("status") == "canceled":
                    task.cancel()
        if drain.exists():
            if not active:
                return
        elif len(active) < concurrency:
            rows = await repo_query("SELECT * FROM command WHERE status = 'new' ORDER BY created ASC LIMIT $limit", {"limit": concurrency - len(active)})
            for row in rows:
                job_id = str(row["id"])
                # A cancellation can race the list query. Claim conditionally.
                claimed = await repo_query("UPDATE $id SET status = 'running' WHERE status = 'new' RETURN AFTER", {"id": ensure_record_id(job_id)})
                if not claimed:
                    continue
                active[job_id] = asyncio.create_task(command_service.execute_command(
                    job_id, f"{row['app']}.{row['name']}", row.get("args", {}), row.get("context", {})))
        await asyncio.sleep(.5)


if __name__ == "__main__":
    asyncio.run(run())
