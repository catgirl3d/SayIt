import fs from "fs";
import path from "path";

/**
 * Resolve a request path to one file inside the web directory.
 *
 * Return values:
 *   { status: 200, file }  -- send this file (it may be the fallback index.html)
 *   { status: 400 }        -- malformed percent-encoding, or the path contains a NUL byte
 *   { status: 404 }        -- the path escapes the root, points to a directory, or the
 *                             fallback page does not exist either
 *
 * Why not new URL(...).pathname: URL parsing normalizes "/../.env" to "/.env" before
 * we ever see it. An escaping request is then treated as "file not found" and falls
 * back to index.html with status 200. The response happens to be safe, but the escape
 * is never recognized. "/..%2f.env" is not normalized by URL parsing at all; it only
 * becomes "/../.env" after decoding. So every check is done on the raw path, after
 * decoding, and an escaping path returns 404 directly without ever reaching the fallback.
 */
export function resolveStaticRequest(rawUrl, rootDir) {
  const raw = String(rawUrl || "/").split("?")[0].split("#")[0];

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes("\0")) return { status: 400 };

  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded;
  // Split on both separators. The server runs on Linux, but a backslash produced by
  // decoding (e.g. "%5c") is still a path separator on Windows, so it must be caught here too.
  if (rel.split(/[\\/]+/).includes("..")) return { status: 404 };

  const root = path.resolve(rootDir);
  const candidate = path.join(root, rel);
  if (!isInside(candidate, root)) return { status: 404 };

  if (!fs.existsSync(candidate)) {
    // Original behavior, kept: a path that does not exist is handed to the frontend
    // page (single-page app fallback).
    const fallback = path.join(root, "index.html");
    return fs.existsSync(fallback) ? { status: 200, file: fallback } : { status: 404 };
  }

  // Resolve symbolic links and directory junctions, then check containment again.
  // A link inside the web directory can point outside it, and the lexical check above
  // cannot see that.
  let real;
  let realRoot;
  try {
    real = fs.realpathSync(candidate);
    realRoot = fs.realpathSync(root);
  } catch {
    return { status: 404 };
  }
  if (!isInside(real, realRoot)) return { status: 404 };

  // Requested directory: the original implementation failed to read a directory and
  // returned 404. Keep that behavior.
  if (fs.statSync(real).isDirectory()) return { status: 404 };

  return { status: 200, file: real };
}

// Compare against "root + path separator" so that a sibling such as /srv/web-evil is not
// mistaken for a path inside /srv/web.
function isInside(target, root) {
  return target === root || target.startsWith(root + path.sep);
}
