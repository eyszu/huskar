// Run with:  bun test
//
// The same assertions run against the example app in two forms:
//   - "bun":    `bun run examples/app.ts`  (framework running on Bun)
//   - "native": the same file compiled by `scriptc build` into a standalone binary
//
// Environment:
//   HUSKAR_TARGETS=bun,native   which targets to run (default: bun, plus native when scriptc is found)
//   SCRIPTC=/path/to/scriptc    scriptc binary (default: `scriptc` on PATH)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parseQueryString, safeDecode, contentTypeIs } from "../src/util";

const ROOT = join(import.meta.dir, "..");
const BUILD_DIR = join(ROOT, "build");
const PUBLIC_DIR = join(ROOT, "tests", "public");

const scriptcBin: string | null = process.env.SCRIPTC ?? Bun.which("scriptc");
const requested = (process.env.HUSKAR_TARGETS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const targets: string[] = requested.length > 0 ? requested : scriptcBin ? ["bun", "native"] : ["bun"];
if (targets.includes("native") && !scriptcBin) {
  throw new Error("HUSKAR_TARGETS includes 'native' but scriptc was not found. Set SCRIPTC=/path/to/scriptc.");
}

// ---------------------------------------------------------------------------------------------
// unit tests (run in-process on Bun)
// ---------------------------------------------------------------------------------------------
describe("util", () => {
  test("parseQueryString decodes, handles flags, '+', and repeated keys (last wins)", () => {
    const out: Record<string, string> = {};
    parseQueryString("a=1&b=x%20y&flag&plus=a+b&a=2&&=skip&c=", out);
    expect(out.a).toBe("2");
    expect(out.b).toBe("x y");
    expect(out.flag).toBe("");
    expect(out.plus).toBe("a b");
    expect(out.c).toBe("");
  });

  test("safeDecode tolerates malformed escapes", () => {
    expect(safeDecode("a%20b")).toBe("a b");
    expect(safeDecode("100%")).toBe("100%");
    expect(safeDecode("%E0%A4%A")).toBe("%E0%A4%A");
  });

  test("contentTypeIs", () => {
    expect(contentTypeIs("application/json; charset=utf-8", "json")).toBe(true);
    expect(contentTypeIs("Application/Vnd.Api+JSON", "json")).toBe(true);
    expect(contentTypeIs("text/plain", "json")).toBe(false);
    expect(contentTypeIs("application/x-www-form-urlencoded", "urlencoded")).toBe(true);
    expect(contentTypeIs("text/plain", "text")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// integration tests (real HTTP against a spawned server)
// ---------------------------------------------------------------------------------------------
/** Sends a request line verbatim (fetch/URL would normalise "/../" and "%2e%2e" before it reaches the server). */
function rawStatus(port: number, requestTarget: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (c) => (data += c.toString()));
    socket.on("end", () => resolve(parseInt(data.split(" ")[1] ?? "0", 10)));
    socket.on("error", reject);
  });
}

async function waitForServer(base: string, proc: Bun.Subprocess, log: () => string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early (code ${proc.exitCode}):\n${log()}`);
    try {
      const r = await fetch(base + "/hello");
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("server did not start in 20s:\n" + log());
}

targets.forEach((target, index) => {
  describe(`huskar on ${target}`, () => {
    const port = 4300 + index;
    const base = `http://127.0.0.1:${port}`;
    let proc: Bun.Subprocess | null = null;
    let output = "";

    const get = (path: string, init?: RequestInit) => fetch(base + path, { redirect: "manual", ...init });
    const json = async (path: string, init?: RequestInit) => {
      const r = await get(path, init);
      return { status: r.status, headers: r.headers, body: await r.json() };
    };
    const send = (method: string, path: string, body?: string, contentType?: string) =>
      get(path, { method, body, headers: contentType ? { "content-type": contentType } : {} });

    beforeAll(async () => {
      let cmd: string[];
      if (target === "native") {
        mkdirSync(BUILD_DIR, { recursive: true });
        const out = join(BUILD_DIR, "app-test");
        const build = Bun.spawnSync([scriptcBin!, "build", "examples/app.ts", "-o", out], { cwd: ROOT });
        if (build.exitCode !== 0) throw new Error("scriptc build failed:\n" + build.stderr.toString() + build.stdout.toString());
        cmd = [out, String(port), PUBLIC_DIR];
      } else {
        cmd = ["bun", "run", "examples/app.ts", String(port), PUBLIC_DIR];
      }
      proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
      const collect = async (s: ReadableStream<Uint8Array>) => {
        for await (const chunk of s) output += new TextDecoder().decode(chunk);
      };
      void collect(proc.stdout as ReadableStream<Uint8Array>);
      void collect(proc.stderr as ReadableStream<Uint8Array>);
      await waitForServer(base, proc, () => output);
    }, 60000);

    afterAll(() => {
      proc?.kill();
    });

    describe("routing", () => {
      test("static route", async () => {
        const r = await get("/");
        expect(r.status).toBe(200);
        expect(await r.text()).toBe("huskar");
      });

      test("path params", async () => {
        const r = await json("/users/42");
        expect(r.body).toEqual({ id: "42", route: "/users/:id" });
      });

      test("multiple params", async () => {
        expect((await json("/users/7/posts/99")).body).toEqual({ id: "7", postId: "99" });
      });

      test("params are percent-decoded", async () => {
        expect((await json("/users/a%20b")).body).toEqual({ id: "a b", route: "/users/:id" });
      });

      test("static segment beats :param regardless of registration order", async () => {
        expect((await json("/users/me")).body).toEqual({ me: true });
      });

      test("wildcard captures the rest of the path", async () => {
        expect((await json("/files/a/b/c.txt")).body).toEqual({ rest: "a/b/c.txt" });
      });

      test("matching is case-insensitive by default", async () => {
        expect(await (await get("/case/sensitive")).text()).toBe("matched");
        expect((await json("/USERS/5")).body).toEqual({ id: "5", route: "/users/:id" });
      });

      test("trailing and doubled slashes are tolerated", async () => {
        expect((await get("/hello/")).status).toBe(200);
        expect((await get("//hello")).status).toBe(200);
      });

      test("unknown path is 404", async () => {
        const r = await get("/nope");
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("Cannot GET /nope");
      });

      test("method mismatch is 404", async () => {
        expect((await send("POST", "/hello")).status).toBe(404);
      });

      test("HEAD falls back to GET routes with no body", async () => {
        const r = await send("HEAD", "/json");
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toContain("application/json");
        expect(await r.text()).toBe("");
      });

      test("OPTIONS answers with Allow", async () => {
        const r = await send("OPTIONS", "/echo");
        expect(r.status).toBe(204);
        const allow = (r.headers.get("allow") ?? "").split(",");
        expect(allow).toContain("POST");
        expect(allow).toContain("PUT");
        expect(allow).toContain("OPTIONS");
      });

      test("app.all matches every method", async () => {
        expect(await (await send("GET", "/any")).text()).toBe("any:GET");
        expect(await (await send("POST", "/any")).text()).toBe("any:POST");
        expect(await (await send("DELETE", "/any")).text()).toBe("any:DELETE");
      });

      test("params never leak between concurrent requests", async () => {
        const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
        const results = await Promise.all(ids.map((id) => json(`/users/${id}/posts/${id}x`)));
        results.forEach((r, i) => expect(r.body).toEqual({ id: ids[i], postId: `${ids[i]}x` }));
      });
    });

    describe("query string, headers, locals", () => {
      test("query parsing", async () => {
        const r = await json("/query?x=1&y=a%20b&z&plus=a+b&x=2");
        expect(r.body).toEqual({ x: "2", y: "a b", z: "", plus: "a b" });
      });

      test("empty query", async () => {
        expect((await json("/query")).body).toEqual({});
        expect((await json("/query?")).body).toEqual({});
      });

      test("req.get / hostname / protocol / xhr", async () => {
        const r = await json("/headers", { headers: { "user-agent": "tester", "x-requested-with": "XMLHttpRequest" } });
        expect(r.body).toEqual({ ua: "tester", host: "127.0.0.1", proto: "http", xhr: true });
      });

      test("global middleware sets headers and locals", async () => {
        const r = await get("/locals");
        expect(r.headers.get("x-request-path")).toBe("/locals");
        expect(await r.json()).toEqual({ startedAt: "t0" });
      });

      test("x-powered-by option", async () => {
        expect((await get("/hello")).headers.get("x-powered-by")).toBe("huskar");
      });
    });

    describe("body parsers", () => {
      test("json", async () => {
        const r = await send("POST", "/echo", JSON.stringify({ a: 1, b: [1, 2], c: { d: "é✓" } }), "application/json");
        expect(await r.json()).toEqual({ body: { a: 1, b: [1, 2], c: { d: "é✓" } } });
      });

      test("json with charset parameter", async () => {
        const r = await send("POST", "/echo", '{"x":1}', "application/json; charset=utf-8");
        expect(await r.json()).toEqual({ body: { x: 1 } });
      });

      test("invalid json is a 400", async () => {
        const r = await send("POST", "/echo", "{nope", "application/json");
        expect(r.status).toBe(400);
        expect(await r.text()).toBe("Invalid JSON");
      });

      test("urlencoded", async () => {
        const r = await send("POST", "/echo", "name=Ada+Lovelace&age=36&tag=a%26b", "application/x-www-form-urlencoded");
        expect(await r.json()).toEqual({ body: { name: "Ada Lovelace", age: "36", tag: "a&b" } });
      });

      test("text", async () => {
        const r = await send("POST", "/echo", "plain words", "text/plain");
        expect(await r.json()).toEqual({ body: "plain words" });
      });

      test("no content type leaves body undefined", async () => {
        const r = await send("POST", "/echo", "ignored");
        expect(await r.json()).toEqual({});
      });

      test("bodies over the limit are rejected with 413", async () => {
        const big = JSON.stringify({ blob: "x".repeat(200_000) });
        const r = await send("POST", "/echo", big, "application/json");
        expect(r.status).toBe(413);
      });

      test("server stays healthy after a 413", async () => {
        expect((await get("/hello")).status).toBe(200);
      });

      test("PUT / PATCH / DELETE", async () => {
        const put = await send("PUT", "/echo", '{"k":"v"}', "application/json");
        expect(put.status).toBe(202);
        expect(await put.json()).toEqual({ body: { k: "v" }, method: "PUT" });
        expect(await (await send("PATCH", "/things/9")).json()).toEqual({ patched: "9" });
        const del = await send("DELETE", "/things/9");
        expect(del.status).toBe(204);
        expect(await del.text()).toBe("");
      });
    });

    describe("responses", () => {
      test("res.json", async () => {
        const r = await json("/json");
        expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(r.body).toEqual({ message: "Hello, World!", n: 1, ok: true, tags: ["a", "b"] });
      });

      test("res.send(string) defaults to html, res.text is text/plain", async () => {
        expect((await get("/")).headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect((await get("/hello")).headers.get("content-type")).toBe("text/plain; charset=utf-8");
      });

      test("res.type respects explicit content types", async () => {
        const r = await get("/type");
        expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await r.json()).toEqual({ raw: true });
      });

      test("res.send(Buffer)", async () => {
        const r = await get("/buffer");
        expect(r.headers.get("content-type")).toBe("application/octet-stream");
        expect(await r.text()).toBe("binary!");
      });

      test("res.send(null) sends an empty body", async () => {
        const r = await get("/null");
        expect(r.status).toBe(200);
        expect(await r.text()).toBe("");
      });

      test("res.sendStatus", async () => {
        const r = await get("/status/404");
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("Not Found");
        expect(await (await get("/status/201")).text()).toBe("Created");
      });

      test("redirects", async () => {
        const a = await get("/redirect");
        expect(a.status).toBe(302);
        expect(a.headers.get("location")).toBe("/hello");
        const b = await get("/redirect301");
        expect(b.status).toBe(301);
        expect(b.headers.get("location")).toBe("/json");
      });

      test("res.sendFile", async () => {
        const ok = await get("/sendfile");
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toBe("text/css; charset=utf-8");
        expect(await ok.text()).toBe("body{color:red}\n");
        expect((await get("/sendfile-missing")).status).toBe(404);
      });

      test("clearCookie / location / chaining", async () => {
        const r = await get("/clear-cookie");
        expect(r.headers.getSetCookie()[0]).toContain("a=;");
        expect(r.headers.getSetCookie()[0]).toContain("Max-Age=0");
        expect(r.headers.get("location")).toBe("/elsewhere");
        expect(await r.text()).toBe("cleared");
      });

      test("set / append headers", async () => {
        const r = await get("/custom-header");
        expect(r.headers.get("x-custom")).toBe("yes");
        expect(r.headers.get("x-multi")).toBe("a, b");
      });

      test("cookies", async () => {
        const r = await get("/cookie");
        const cookies = r.headers.getSetCookie();
        expect(cookies).toHaveLength(2);
        expect(cookies[0]).toContain("a=1%202");
        expect(cookies[0]).toContain("HttpOnly");
        expect(cookies[0]).toContain("Max-Age=60");
        expect(cookies[1]).toContain("b=x");
      });
    });

    describe("control flow and errors", () => {
      test("handler chain with next()", async () => {
        expect((await json("/chain")).body).toEqual({ step: "one" });
      });

      test('next("route") skips to the next matching route', async () => {
        expect(await (await get("/skip")).text()).toBe("second route");
      });

      test("async handlers", async () => {
        expect((await json("/async")).body).toEqual({ async: true });
      });

      test("sync throw becomes a 500 without leaking details", async () => {
        const r = await get("/throw");
        expect(r.status).toBe(500);
        expect(await r.text()).toBe("Internal Server Error");
      });

      test("async rejection reaches the default error handler", async () => {
        const r = await get("/async-fail");
        expect(r.status).toBe(418);
        expect(await r.text()).toBe("teapot");
      });

      test("next(HttpError) uses its status", async () => {
        const r = await get("/http-error");
        expect(r.status).toBe(403);
        expect(await r.text()).toBe("nope");
      });

      test("custom onError handler", async () => {
        const r = await json("/handled");
        expect(r.status).toBe(409);
        expect(r.body).toEqual({ handled: true, message: "conflict" });
      });

      test("middleware registered after a route runs only on fall-through", async () => {
        const fell = await get("/fallthrough");
        expect(fell.status).toBe(404);
        expect(fell.headers.get("x-after")).toBe("1");
        expect((await get("/nope")).headers.get("x-after")).toBe("1");
        expect((await get("/hello")).headers.get("x-after")).toBeNull();
      });

      test("server survives many failing requests", async () => {
        const rs = await Promise.all(Array.from({ length: 40 }, () => get("/throw")));
        expect(rs.every((r) => r.status === 500)).toBe(true);
        expect((await get("/hello")).status).toBe(200);
      });
    });

    describe("routers and prefixed middleware", () => {
      test("mounted router", async () => {
        const r = await json("/api/ping");
        expect(r.body).toEqual({ pong: true, base: "/api" });
        expect(r.headers.get("x-api")).toBe("1");
      });

      test("params inside mounted router", async () => {
        expect((await json("/api/items/9")).body).toEqual({ item: "9", base: "/api" });
      });

      test("nested routers expose the full baseUrl", async () => {
        const r = await json("/api/v1/deep");
        expect(r.body).toEqual({ deep: true, base: "/api/v1" });
        expect(r.headers.get("x-api")).toBe("1");
      });

      test("routes added to a mounted router after listen() are served", async () => {
        expect((await json("/api/late")).body).toEqual({ late: true, base: "/api" });
      });

      test("app.route chaining", async () => {
        expect(await (await send("GET", "/api/chained")).text()).toBe("chained get");
        expect(await (await send("POST", "/api/chained")).text()).toBe("chained post");
      });

      test("router middleware also runs for unmatched paths under its prefix", async () => {
        const r = await get("/api/does-not-exist");
        expect(r.status).toBe(404);
        expect(r.headers.get("x-api")).toBe("1");
        expect((await get("/elsewhere")).headers.get("x-api")).toBeNull();
      });

      test("prefixed middleware guards its subtree only", async () => {
        const denied = await get("/guarded/data");
        expect(denied.status).toBe(401);
        const allowed = await json("/guarded/data", { headers: { "x-token": "secret" } });
        expect(allowed.body).toEqual({ secret: 42 });
        expect((await get("/guarded/unrouted")).status).toBe(401);
        expect((await json("/open/data")).body).toEqual({ secret: 0 });
      });
    });

    describe("static files", () => {
      test("serves files with the right content type", async () => {
        const r = await get("/static/style.css");
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("text/css; charset=utf-8");
        expect(await r.text()).toBe("body{color:red}\n");
      });

      test("directory index", async () => {
        expect(await (await get("/static/")).text()).toBe("<h1>index</h1>\n");
        expect(await (await get("/static/sub")).text()).toBe("<p>sub index</p>\n");
      });

      test("nested files", async () => {
        expect(await (await get("/static/sub/page.txt")).text()).toBe("nested\n");
      });

      test("missing files fall through to 404", async () => {
        expect((await get("/static/missing.png")).status).toBe(404);
      });

      test("path traversal is refused", async () => {
        expect(await rawStatus(port, "/static/../../package.json")).toBe(403);
        expect(await rawStatus(port, "/static/%2e%2e/%2e%2e/package.json")).toBe(403);
        expect(await rawStatus(port, "/static/sub/..%2f..%2fpackage.json")).toBe(403);
        expect(await rawStatus(port, "/static/..%5cpackage.json")).toBe(400);
      });

      test("HEAD", async () => {
        const r = await send("HEAD", "/static/style.css");
        expect(r.status).toBe(200);
        expect(await r.text()).toBe("");
      });

      test("cached mode serves identical content", async () => {
        const a = await (await get("/cached/style.css")).text();
        const b = await (await get("/cached/style.css")).text();
        expect(a).toBe("body{color:red}\n");
        expect(b).toBe(a);
      });
    });

    describe("robustness", () => {
      test("keep-alive: many sequential requests on one connection", async () => {
        for (let i = 0; i < 100; i++) {
          const r = await get("/hello");
          expect(await r.text()).toBe("Hello, World!");
        }
      });

      test("high concurrency", async () => {
        const rs = await Promise.all(Array.from({ length: 200 }, (_, i) => json(`/users/${i}`)));
        rs.forEach((r, i) => expect(r.body).toEqual({ id: String(i), route: "/users/:id" }));
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// native-only guard: the app must stay fully static so it keeps scriptc's performance profile
// ---------------------------------------------------------------------------------------------
if (targets.includes("native")) {
  describe("scriptc", () => {
    test("examples/app.ts compiles 100% statically", () => {
      const r = Bun.spawnSync([scriptcBin!, "coverage", "examples/app.ts"], { cwd: ROOT });
      const out = r.stdout.toString();
      expect(r.exitCode).toBe(0);
      expect(out).toMatch(/compile statically\s+\d+\s+\(100%\)/);
    });

    test("the hot request path has no dynamic-tier code", () => {
      const r = Bun.spawnSync([scriptcBin!, "coverage", "examples/app.ts", "--explain-dynamic"], { cwd: ROOT });
      const out = r.stdout.toString();
      // Cold paths (HttpError rendering, the node:http callback adapter, Number/body edge cases) may be dynamic.
      for (const hot of ["App.handle", "App.lookup", "App.matchNode", "Run.advance", "Run.call", "Req.", "Res.json", "Res.send"]) {
        expect(out).not.toContain(hot);
      }
    });
  });
}
