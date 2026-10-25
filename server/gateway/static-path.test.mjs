// Run: node --test server/gateway/
// No third-party packages are needed. Every case asserts the status code. Cases that
// escape the web directory also assert that the response did not fall back to index.html.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveStaticRequest } from "./static-path.mjs";

let base;
let web;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sayit-gw-"));
  web = path.join(base, "web");
  fs.mkdirSync(path.join(web, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "INDEX");
  fs.writeFileSync(path.join(web, "app.js"), "APP");
  fs.writeFileSync(path.join(web, "fonts", "a.woff2"), "FONT");
  fs.writeFileSync(path.join(base, ".env"), "SECRET");
  // Adjacent directory whose name shares the prefix: /x/web-x must not be treated as
  // being inside /x/web.
  fs.mkdirSync(path.join(base, "web-x"));
  fs.writeFileSync(path.join(base, "web-x", "secret.txt"), "SIBLING");
  // Directory junctions inside web that point outside it. On Windows, creating file
  // symlinks requires administrator rights, but junctions do not. On Linux the "junction"
  // argument is ignored and a regular directory symlink is created instead.
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(base, "outside", "leak.txt"), "LEAK");
  fs.symlinkSync(path.join(base, "outside"), path.join(web, "link-out"), "junction");
  fs.symlinkSync(path.join(base, "web-x"), path.join(web, "link-sibling"), "junction");
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const indexFile = () => path.join(web, "index.html");

function rejected(url, status) {
  const r = resolveStaticRequest(url, web);
  assert.equal(r.status, status, `${url} -> ${JSON.stringify(r)}`);
  assert.equal(r.file, undefined, `${url} must not fall back to a file`);
}

test("traversal is rejected with 404 and never falls back", () => {
  rejected("/../.env", 404);
  rejected("/%2e%2e/.env", 404);
  rejected("/%2E%2E/.env", 404);
  rejected("/..%2f.env", 404);
  rejected("/..%5c.env", 404);
  rejected("/a/../../.env", 404);
  rejected("/\\..\\.env", 404);
  rejected("/fonts/../../.env", 404);
  rejected("/..", 404);
});

test("malformed encoding and NUL are rejected with 400", () => {
  rejected("/%E0%A4%A", 400);
  rejected("/%", 400);
  rejected("/%00.env", 400);
  rejected("/app.js%00.png", 400);
});

test("links pointing outside the web dir are rejected", () => {
  rejected("/link-out/leak.txt", 404);
  rejected("/link-sibling/secret.txt", 404);
});

test("normal files are served", () => {
  assert.deepEqual(resolveStaticRequest("/", web), { status: 200, file: fs.realpathSync(indexFile()) });
  assert.equal(resolveStaticRequest("/app.js", web).file, fs.realpathSync(path.join(web, "app.js")));
  assert.equal(resolveStaticRequest("/fonts/a.woff2", web).file, fs.realpathSync(path.join(web, "fonts", "a.woff2")));
});

test("query string and fragment are ignored", () => {
  // Before the fix, a query string made the file lookup fail and fell back to index.html.
  assert.equal(resolveStaticRequest("/app.js?v=2", web).file, fs.realpathSync(path.join(web, "app.js")));
  assert.equal(resolveStaticRequest("/app.js#x", web).file, fs.realpathSync(path.join(web, "app.js")));
});

test("unknown paths keep falling back to index.html", () => {
  assert.deepEqual(resolveStaticRequest("/not-exist-page", web), { status: 200, file: indexFile() });
  assert.deepEqual(resolveStaticRequest("/a/b/c", web), { status: 200, file: indexFile() });
});

test("requesting a directory stays 404 like before", () => {
  rejected("/fonts", 404);
  rejected("/fonts/", 404);
});

// Simulates a file that disappears (ENOENT) or becomes unreadable (EACCES) after the
// existence check and realpath succeeded. The stat failure must become a 404, not an
// exception that would escape the HTTPS request callback and crash the gateway.
function withStatFailure(code, fn) {
  const failing = mock.method(fs, "statSync", () => {
    throw Object.assign(new Error(`${code}: simulated stat failure`), { code });
  });
  try {
    fn();
  } finally {
    failing.mock.restore();
  }
}

test("a file removed between existence check and stat answers 404 without throwing", () => {
  withStatFailure("ENOENT", () => {
    const r = resolveStaticRequest("/app.js", web);
    assert.deepEqual(r, { status: 404 });
  });
});

test("an unreadable file (EACCES) answers 404 without throwing", () => {
  withStatFailure("EACCES", () => {
    const r = resolveStaticRequest("/app.js", web);
    assert.deepEqual(r, { status: 404 });
  });
});
