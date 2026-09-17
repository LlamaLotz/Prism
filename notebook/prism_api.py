"""Small desktop adapter around the pinned, otherwise unmodified upstream API.

Upstream's job list/cancel methods are placeholders. Prism exposes real status
and cancellation through the same routes and supervises a draining worker.
"""
import os
from pathlib import Path

from fastapi import HTTPException, Query
from api.main import app
from open_notebook.database.repository import ensure_record_id, repo_query

app.router.routes = [r for r in app.router.routes if not (
    (getattr(r, "path", None) == "/api/commands/jobs" and "GET" in getattr(r, "methods", set()))
    or (getattr(r, "path", None) == "/api/commands/jobs/{job_id}" and "DELETE" in getattr(r, "methods", set()))
)]


@app.get("/api/commands/jobs")
async def jobs(status_filter: str | None = None, command_filter: str | None = None, limit: int = Query(100, ge=1, le=1000)):
    rows = await repo_query(
        "SELECT id, name, status, error_message, created, updated FROM command "
        "WHERE ($status = NONE OR status = $status) AND ($name = NONE OR name = $name) "
        "ORDER BY created DESC LIMIT $limit",
        {"status": status_filter, "name": command_filter, "limit": limit},
    )
    return [{"id": str(r["id"]), "command_name": r.get("name"), "status": r.get("status"),
             "error": r.get("error_message"), "created": str(r.get("created", ""))} for r in rows]


@app.delete("/api/commands/jobs/{job_id}")
async def cancel(job_id: str):
    if not job_id.startswith("command:"):
        raise HTTPException(400, "Invalid job identifier")
    rows = await repo_query(
        "UPDATE $id SET status = 'canceled', error_message = 'Canceled by user' "
        "WHERE status IN ['new', 'running'] RETURN AFTER",
        {"id": ensure_record_id(job_id)},
    )
    if not rows:
        raise HTTPException(409, "Job has already finished or does not exist")
    return {"job_id": job_id, "cancelled": True}


@app.post("/api/prism/drain")
async def drain():
    Path(os.environ["PRISM_NOTEBOOK_DATA"], ".drain").touch()
    return {"draining": True}
