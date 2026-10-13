"""Shared HTTP client IP extraction.

Behind the ALB, ``request.client.host`` is the proxy's internal address and
looks identical for every user, so per-IP limits and stored IPs must come
from ``X-Forwarded-For``. The left-most entry is the client as seen by the
edge; with a single trusted proxy hop that is the real client. A blank
left-most entry (whitespace-only header or a client-sent leading comma) is
treated as no forwarded value and falls back the same way. More untrusted
proxy hops would require counting from the right by trusted-hop count instead.
The WebSocket path in main.py reads the same headers but keeps its own
handling because it also reports the direct peer and the raw forwarded value.
"""
from __future__ import annotations

from starlette.requests import Request


def get_client_ip(request: Request) -> str:
    """Left-most X-Forwarded-For entry, falling back to the direct peer or "unknown"."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        leftmost = forwarded.split(",")[0].strip()
        if leftmost:
            return leftmost
    return request.client.host if request.client else "unknown"
