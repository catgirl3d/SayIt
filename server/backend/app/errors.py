"""Internal error messages sent to the client.

Exception text often contains server-internal paths, dependency names and versions, GPU errors and
upstream service URLs. None of that helps a user, and to someone trying to attack the server it is
ready-made intelligence. So the client gets one fixed sentence plus a reference id, and the original
text and stack trace go only to the server log.

The reference id is generated separately for each error and is not reused from the connection id
(cid): one connection can carry several sessions one after another, so the cid alone would not tell
which session failed. The log line contains ref, cid and sid together, so the full original text can
be found from the ref.
"""
from __future__ import annotations

import logging
import secrets

logger = logging.getLogger("sayit.errors")

try:  # httpx timeouts are not subclasses of the built-in TimeoutError
    import httpx

    _TIMEOUT_TYPES: tuple[type[BaseException], ...] = (TimeoutError, httpx.TimeoutException)
except ImportError:  # pragma: no cover
    _TIMEOUT_TYPES = (TimeoutError,)


def new_ref() -> str:
    return secrets.token_hex(4)


def is_timeout(exc: BaseException) -> bool:
    return isinstance(exc, _TIMEOUT_TYPES)


def public_error_message(exc: BaseException, *, where: str, cid: str | None = None, sid: str | None = None) -> tuple[str, str]:
    """Log the error with its stack and return (message for the client, reference id).

    Timeouts get their own sentence: the client's errorMessages.ts recognizes "timed out" and shows
    the timeout-specific hint. If every failure used the generic message, users could not tell a
    timeout apart from another fault.
    """
    ref = new_ref()
    logger.error("internal error ref=%s where=%s cid=%s sid=%s: %s", ref, where, cid or "-", sid or "-", exc, exc_info=exc)
    if is_timeout(exc):
        return f"Server processing timed out (ref: {ref})", ref
    return f"Internal server error (ref: {ref})", ref
