"""HTTP request body size limit (pure ASGI middleware).

Why the limit is enforced at the outermost ASGI layer and not inside the endpoint functions:
FastAPI receives and parses the whole form and file payload before the endpoint function runs
(large files are first spooled to the temp directory), so counting bytes inside the function is
too late: the data has already been received. `await request.json()` accepts any size at all.
The limit therefore has to take effect at the layer that reads the request body from the wire.

The criterion is the number of bytes **actually received**; Content-Length is not trusted. The
declared value is used only for early rejection (when the declaration is already over the limit,
not a single byte is read). A request that declares a small length but sends more is caught by the
running count. Chunked uploads have no such header and are counted the same way.

On overflow: reply 413 immediately, then pretend to the inner application that the client
disconnected. An exception is not raised because FastAPI turns any exception raised while parsing
a form into a 400 (the `except Exception` in routing.py), so a raised exception would never reach
this layer and the user would see a wrong 400. Any response the inner application sends after
that point is discarded.

This layer must sit **inside** the CORS middleware: the 413 must also carry the CORS headers,
otherwise the browser blocks the desktop client's fetch and the user only sees a "network error".
"""
from __future__ import annotations

import asyncio
import gc
import json
import logging
from dataclasses import dataclass

logger = logging.getLogger("sayit.bodylimit")

# After replying 413, read and discard at most this many multiples of the rule limit, and for at
# most this many seconds; see the explanation in _reject
DRAIN_FACTOR = 2
DRAIN_SECONDS = 30


@dataclass(frozen=True, slots=True)
class BodyLimitRule:
    limit: int
    # JSON returned to the client when the limit is exceeded. The endpoint's original error format
    # is kept so that the messages the client already handles still match
    payload: dict


def _client_hint(scope) -> str:
    client = scope.get("client") or ("-", 0)
    for name, value in scope.get("headers") or []:
        if name == b"x-forwarded-for":
            return f"{client[0]} xff={value.decode('latin-1')[:120]}"
    return str(client[0])


def _declared_length(scope) -> int | None:
    for name, value in scope.get("headers") or []:
        if name == b"content-length":
            text = value.decode("latin-1").strip()
            return int(text) if text.isdigit() else None
    return None


class BodyLimitMiddleware:
    def __init__(
        self,
        app,
        *,
        exact: dict[str, BodyLimitRule],
        prefixes: list[tuple[str, BodyLimitRule]],
        default: BodyLimitRule,
    ) -> None:
        self.app = app
        self._exact = exact
        self._prefixes = prefixes
        self._default = default

    def rule_for(self, path: str) -> BodyLimitRule:
        rule = self._exact.get(path)
        if rule is not None:
            return rule
        for prefix, prefix_rule in self._prefixes:
            if path == prefix.rstrip("/") or path.startswith(prefix):
                return prefix_rule
        return self._default

    async def __call__(self, scope, receive, send):
        # WebSocket connections take a different path and have their own audio limit, so they are not touched here
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        rule = self.rule_for(path)
        declared = _declared_length(scope)

        if declared is not None and declared > rule.limit:
            drained = await self._reject(receive, send, rule, received=0, more_body=declared <= rule.limit * DRAIN_FACTOR)
            self._log(scope, path, rule, declared=declared, received=0, drained=drained)
            return

        received = 0
        rejected = False
        response_started = False

        async def guarded_receive():
            nonlocal received, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > rule.limit:
                    rejected = True
                    drained = 0
                    if not response_started:
                        drained = await self._reject(
                            receive, send, rule, received=received, more_body=message.get("more_body", False)
                        )
                    self._log(scope, path, rule, declared=declared, received=received, drained=drained)
                    # Pretend to the inner application that the client disconnected. Starlette raises
                    # ClientDisconnect on this, parsing stops here, and the code that would write to
                    # the database or disk after it is never reached
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message):
            nonlocal response_started
            if rejected:
                # The 413 has already gone out; any 400/500 the inner application produces afterwards is dropped
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, guarded_receive, guarded_send)
        except Exception:
            # Swallow only the abort we triggered (ClientDisconnect or the parse failure it causes);
            # any other exception is re-raised unchanged
            if not rejected:
                raise
        finally:
            if rejected:
                # When multipart parsing is aborted midway, Starlette does not close the temp files it
                # already created (it only closes them on MultiPartException). The file objects are held
                # in a reference cycle between the exception and the stack frames, so they are freed only
                # by the cyclic garbage collector. On Linux they are anonymous unlinked files that do not
                # show up in /tmp, yet they keep occupying disk space, and repeated oversize requests
                # could pile them up. A local measurement showed one still alive after the request ended.
                # This runs once on the reject path only; the volume is bounded by the rate limiter, so
                # the cost is acceptable.
                gc.collect()

    @staticmethod
    async def _reject(receive, send, rule: BodyLimitRule, *, received: int, more_body: bool) -> int:
        """Reply 413. Returns the number of bytes read and discarded for this.

        The response headers are sent first, then the rest of the request body is read and discarded,
        and only then is the response body sent to close the exchange. If the exchange is closed
        without reading the rest, the server closes the connection while the client is still uploading.
        The kernel then holds unread data and sends a TCP RST, and the client often never receives the
        413 at all, only "connection reset". This was observed upstream with a 52 MiB upload.
        Discarded data never goes into memory or onto disk, it only costs bandwidth. The drain is capped
        at DRAIN_FACTOR times the rule limit and DRAIN_SECONDS seconds; beyond that the exchange is closed
        immediately, since a body that large can only be malicious, and it may take the RST.
        """
        body = json.dumps(rule.payload, ensure_ascii=False).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    # This connection is not reused
                    (b"connection", b"close"),
                ],
            }
        )
        drained = 0
        cap = rule.limit * DRAIN_FACTOR
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DRAIN_SECONDS
        while more_body and received + drained <= cap:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                message = await asyncio.wait_for(receive(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if message["type"] != "http.request":
                break
            drained += len(message.get("body", b""))
            more_body = message.get("more_body", False)
        await send({"type": "http.response.body", "body": body, "more_body": False})
        return drained

    @staticmethod
    def _log(scope, path: str, rule: BodyLimitRule, *, declared: int | None, received: int, drained: int) -> None:
        logger.warning(
            "body limit exceeded path=%s method=%s limit=%d declared=%s received=%d drained=%d client=%s",
            path,
            scope.get("method", "-"),
            rule.limit,
            "-" if declared is None else declared,
            received,
            drained,
            _client_hint(scope),
        )


def build_body_limit_rules(limits) -> dict:
    """Build the middleware arguments from the BodyLimitConfig. Error formats match the endpoints' original ones."""
    return {
        "exact": {
            # Only the submission itself gets the raised limit; the withdraw endpoint
            # (/api/asr-corrections/{id}/withdraw) uses the default limit
            "/api/asr-corrections": BodyLimitRule(
                limits.asr_corrections,
                {"error": "audio_too_large", "message": "Request body is too large"},
            ),
        },
        # This fork has no admin dashboard, so there are no prefix rules
        "prefixes": [],
        "default": BodyLimitRule(limits.default, {"error": "payload too large"}),
    }
