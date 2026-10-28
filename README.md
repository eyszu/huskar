# huskar

An Express-style web microframework **designed to be compiled to a native binary by [scriptc](https://scriptc.dev)**.

The API will feel familiar if you have used Express or [ultimate-express](https://github.com/dimdenGD/ultimate-express). The implementation is not a port of either: every design decision was made against what scriptc compiles to fast machine code, and the result is verified by tests that fail if the request path stops being statically compiled.

```ts
import { huskar, json } from "huskar";

const app = huskar();
app.use(json());

app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id, verbose: req.query.verbose === "1" });
});

app.post("/echo", (req, res) => { res.json({ body: req.body }); });

app.listen(3000, () => console.log("up"));
```

```
$ scriptc build app.ts -o app && ./app        # ~1 MB native binary, ~7 ms to first accept, ~5 MB RSS
$ bun run app.ts                              # the same source also runs on Bun
```

**Status:** experimental, v0.1. Tested with scriptc 0.4.5, Bun 1.4.4, Node 22. 133 tests, run against both Bun and the scriptc binary.

---

## Contents

1. [Why it is fast](#1-why-it-is-fast)
2. [Architecture](#2-architecture)
3. [Writing scriptc-friendly code](#3-writing-scriptc-friendly-code)
4. [API reference](#4-api-reference)
5. [Differences from Express and ultimate-express](#5-differences-from-express-and-ultimate-express)
6. [Benchmarks](#6-benchmarks)
7. [Testing](#7-testing)
8. [Limitations](#8-limitations)
9. [Project layout](#9-project-layout)

---

## 1. Why it is fast

### What scriptc is good at

I benchmarked 19 CPU workloads on Node 22, Bun 1.4.4 and scriptc 0.4.5 before designing anything (`ts-bench/`, 2 runs × 3 iterations, median ms, lower is better, 2-core VM). The workloads that matter to a web framework are the ones scriptc wins by the most:

| workload | Node | Bun | scriptc | scriptc vs Node |
|---|---:|---:|---:|---:|
| Map/Set insert + lookup + delete | 372 | 489 | 83 | **4.5×** |
| JSON.parse (50k records) | 75 | 58 | 21 | **3.7×** |
| JSON.stringify (50k records) | 41 | 25 | 14 | **3.0×** |
| JSON parse → transform → stringify | 114 | 57 | 40 | **2.9×** |
| string build / split / join | 231 | 139 | 74 | **3.1×** |
| word frequency (string split + Map) | 137 | 90 | 32 | **4.3×** |
| virtual dispatch (typed classes) | 53 | 64 | 37 | 1.4× |
| mandelbrot (pure float loop) | 152 | 173 | 149 | 1.0× (parity) |
| string scan (`charCodeAt` loop) | 30 | 29 | 29 | 1.0× (parity) |

So: **hash maps, JSON, string handling and typed objects are fast; tight numeric loops are merely on par with V8/JSC.** A router is a hash-map-and-strings problem, and a JSON API is a JSON problem. That is the part of the workload huskar puts on the fast path.

### What that turned into

| scriptc strength | huskar design decision |
|---|---|
| `Map` is ~4.5× faster | Exact paths are resolved with one `Map.get` per request (`exact: Map<method, Map<path, Route>>`). Trie nodes keep static children in a `Map`. |
| JSON is 3–4× faster | `res.json` and the body parsers call the runtime's native `JSON.stringify` / `JSON.parse` directly, with no wrapper or custom serializer. |
| Strings are fast, regexes are not a selling point | No regex anywhere on the request path. Path splitting is `indexOf`/`slice`, query parsing is a hand-written scanner, route patterns are compiled to a segment trie instead of a `path-to-regexp` regex. |
| Typed classes and direct calls are cheap | `Req`, `Res`, `Route`, `Entry`, `Run` are plain classes with fully typed fields. No `any`, no dynamic property bags on the hot path. |
| Whole-program static compilation | Everything the framework can decide ahead of time is decided in `compile()` (called by `listen()`): mounts are flattened, middleware chains are precomputed per route, guards are resolved. |
| Allocation is cheap (binary trees: 2.1× faster than Node) | Per request: `Req`, `Res`, one `Run`, one `next` closure, the `params`/`query` records and two (empty) `locals` maps. No per-step closures, no promise wrappers for sync handlers. |

### What it measured to

On a 2-core VM with the server pinned to one core (details in [§6](#6-benchmarks)):

- **huskar native uses 2.3–3.0× less CPU per request than ultimate-express and 8.3–9.3× less than Express**, on the same five routes.
- **huskar costs about the same as a hand-written native server with no framework** (within ~1–4 µs per request). The remaining ~19 µs per request is scriptc's `node:http` runtime plus the kernel TCP stack. Nothing in the framework is a meaningful share of it, so further gains have to come from scriptc's HTTP layer, not from huskar.

---

## 2. Architecture

### 2.1 Two phases: register, then compile

```
 registration (your code)                      compile()  — once, at listen()          request time
 ─────────────────────────                     ─────────────────────────────           ───────────────────────
 app.use(...)        ─┐                        1. flatten mounted routers              handle(req, res)
 app.get("/x", ...)   ├─► Layer[] (a stack) ─► 2. one Route per (method, pattern)       ├─ parse path + query
 app.mount("/a", r)   │                        3. precompute each Route's chain        ├─ exact Map hit? ─┐
 app.onError(...)    ─┘                        4. index: exact Map + segment trie       ├─ else trie match │
                                                                                         └─ Run(chain).advance()
```

Any registration after `compile()` marks the app dirty (the flag propagates up through every router it is mounted in), and the next request recompiles. After warm-up, requests only ever read compiled structures.

### 2.2 Routing

Every route is registered in two indexes per HTTP method:

1. **Exact map**: static patterns (`/hello`, `/api/ping`) go in `Map<string, Route>`. A request whose path is already lowercase and normalized resolves with one `Map.get`: no splitting, no allocation.
2. **Segment trie**: all patterns, including `:param` and `*` ones. Each node has `statics: Map<string, TrieNode>`, one `param` child, and optional `route` / `wild` slots. Matching walks the path with `indexOf("/")`/`slice`, without `split`.

Match priority is **static segment > `:param` > `*` wildcard**, with backtracking: `/users/me` beats `/users/:id` regardless of registration order, and `/users/:id/posts` still matches `/users/me/posts` if `/users/me` has no `posts` child. Matching is case-insensitive by default (static segments are lowercased once at compile time; request segments only on a miss in the exact map; captured param values keep their case). Params are percent-decoded; trailing and doubled slashes are ignored.

Matched path parameters are collected in a scratch array on the app and copied into `req.params` only on success, so failed backtracking branches cannot leak params.

Two intentional simplifications relative to Express: a request is routed to the **single most specific matching pattern** (not "every pattern in registration order"), and several `app.get` calls for the *same* pattern are merged into one chain in registration order.

### 2.3 Middleware chains are precomputed

For each `Route`, `compile()` walks the flattened layer list once and builds its complete `Entry[]` chain: the applicable `use()` layers and error handlers, interleaved with the route's own handlers **in registration order**. Consequences:

- `app.use(mw)` registered **before** a route runs before it; registered **after**, it runs only if the route calls `next()` (or nothing matched). This is verified by tests.
- Prefix middleware (`app.useAt("/api", mw)`) is resolved at compile time against each route's pattern: *applies* → included unconditionally, *never applies* → dropped, *depends on a param/wildcard* → included with a one-string runtime `guard` that is checked with `startsWith`. Most chains therefore contain no checks at all.
- Requests that match no route run a precomputed **fallback chain** containing only guarded middleware and error handlers, so `/api`-scoped middleware still runs for unknown `/api/...` paths, as in Express.
- **Mounted routers are flattened**, not nested. `app.mount("/api", router)` copies the router's layers into the app's flat list with the prefix applied. At request time there is no nested dispatch, no URL rewriting, and `req.baseUrl` is a precomputed string on each entry.

### 2.4 The request runner

`Run` executes one chain. It holds `{chain, i, req, res, next}` and creates **one** `next` closure per request (not per handler). `advance(err)`:

1. `err === "route"` skips the remaining handlers of the current route (`Entry.routeId`).
2. Without an error it runs the next `Handler` entry; with an error it runs the next `ErrorHandler` entry, skipping plain handlers.
3. At the end of the chain it calls `defaultError` (if an error is pending) or `notFound`.

Handlers may be `async`: the returned value is checked with `instanceof Promise` and a rejection is routed to `advance(err)`. Synchronous throws are caught around the call. Uncaught errors become a 500 with a generic body: only `HttpError` messages are exposed.

### 2.5 Request and response objects

`Req` and `Res` are thin typed wrappers over the runtime's `IncomingMessage` / `ServerResponse` (reachable as `req.raw` / `res.raw`). Headers are written straight to the underlying response, so there is no intermediate header map to build and flush. `res.json(x)` is: set `content-type` if absent → `JSON.stringify` → `end`. Status reason phrases come from a local `Map<number,string>`, not `http.STATUS_CODES`, which compiles to the dynamic tier.

### 2.6 Body parsers

`json()`, `urlencoded()`, `text()` are ordinary middleware. They check `Content-Type` first (so non-matching requests cost one header lookup), reject on `Content-Length` over the limit before reading anything, then accumulate UTF-8 chunks with a running byte count (default limit 100 KiB → `413`). Invalid JSON → `400 Invalid JSON`. They call `next()` from the `end` event.

---

## 3. Writing scriptc-friendly code

These are the rules huskar follows, and the pitfalls I hit while building it against scriptc 0.4.5. They matter for your own handlers too, because **one dynamic-tier statement in a hot handler costs you the native-speed path for that function**.

### Check what you got

```
scriptc coverage app.ts                      # % compiled statically, plus blockers
scriptc coverage app.ts --explain-dynamic    # which functions fall to the dynamic tier, and why
```

`npm test` includes a guard: `examples/app.ts` must be 100% static, and none of `App.handle`, `App.lookup`, `App.matchNode`, `Run.advance`, `Run.call`, `Req.*`, `Res.json`, `Res.send` may appear in the dynamic-tier list. A refactor that silently slows the request path fails the test suite.

### Rules and idioms

| Do | Don't | Why (observed) |
|---|---|---|
| `import type { Handler } from "./types"` for type-only imports | `import { Handler }` | The runtime module graph fails with `does not provide an export named 'Handler'`. |
| Register error handlers with `app.onError(fn)` | Rely on `fn.length === 4` like Express | `Function.length` has no scriptc lowering (`SC2020`). |
| Separate `use()`, `useAt()`, `mount()` methods | One `use(a, b?)` overloaded on `string \| fn \| Router` | `instanceof` on a union of class instances and functions is rejected (`SC1090`). |
| `locals: Map<string, unknown>` | `locals: Record<string, unknown>` as a class field | `Record<string, unknown>` class fields are not supported yet. (`Record<string, string>` fields are fine.) |
| `for (const k of names)` and `const v = vals[i]; if (v === undefined) break;` | `rec[names[i]] = vals[i]` | An indexed read can be out of bounds, so the result is coerced dynamically (`dyn.toStringCoerce`). The `for…of` + explicit `undefined` check form stays static. This was on huskar's per-request path. |
| `parseInt(s, 10)` | `Number(s)` | `Number(...)` goes through `dyn.numberConstructor`. |
| Local `Map<number,string>` for status text | `http.STATUS_CODES[code]` | Flagged as dynamic-tier when used in `redirect`. |
| Plain typed locals, `unknown` + `typeof` narrowing | `any`, dynamic property bags | Values typed only at runtime take the dynamic tier. |
| `req.headers[name] as string \| undefined` | Treating header values as `string \| string[]` | scriptc types them as `string`, so the array branch narrows to `never`. |

### What is still dynamic in huskar, and why it is acceptable

`coverage --explain-dynamic` reports a few dynamic items, all **off the hot path**:

- the `node:http` callback adapter (`dyn.this`), which is present even in a minimal `createServer` hello-world;
- `HttpError` handling (`class HttpError extends Error`, `instanceof`, `.message`), which is only reached when something fails;
- `req.body = {}` for an empty JSON body.

---

## 4. API reference

### Creating an app

```ts
import { huskar, createRouter, json, urlencoded, text, serveStatic, HttpError } from "huskar";

const app = huskar({ caseSensitive: false, poweredBy: false, trustProxy: false, silent: false });
```

| option | default | meaning |
|---|---|---|
| `caseSensitive` | `false` | Match route paths case-sensitively. |
| `poweredBy` | `false` | Send `X-Powered-By: huskar`. (Express defaults to on.) |
| `trustProxy` | `false` | Use `X-Forwarded-For/Proto/Host` for `req.ip`, `req.protocol`, `req.hostname`. |
| `silent` | `false` | Do not log 5xx errors to stderr. |

### App and Router

`App` extends `Router`, so everything here works on both.

| method | notes |
|---|---|
| `get/post/put/patch/delete/head/options/all(path, ...handlers)` | Returns the router for chaining. `all` registers for every supported method. |
| `use(...handlers)` | Middleware for every request. |
| `useAt(path, ...handlers)` | Middleware for a path prefix (`/api` matches `/api` and `/api/x`, not `/apix`). |
| `mount(path, router)` | Mount a router or app; flattened at compile time. Mounts may nest. |
| `onError(handler)` | `(err, req, res, next) => void \| Promise<void>`. Call `next(err)` to pass it on. |
| `route(path)` | `app.route("/x").get(h).post(h)` |
| `listen(port, cb?)` / `listenOn(port, host, cb?)` | Compile, create the server, listen. Returns the `http.Server`. |
| `createServer()` | Compile and return the server without listening. |
| `handle(rawReq, rawRes)` | Dispatch one request; use this to host huskar inside your own server. |
| `close()` | Stop the server. In scriptc 0.4.5 the process exits about 1–2 s later; Node exits immediately. |

**Route patterns:** `/users`, `/users/:id`, `/users/:id/posts/:postId`, `/files/*` (wildcard, captured as `req.params["0"]`). Not supported: optional params (`:id?`), regex routes, `app.param`.

### Handlers

```ts
type Handler      = (req: Req, res: Res, next: Next) => void | Promise<void>;
type ErrorHandler = (err: unknown, req: Req, res: Res, next: Next) => void | Promise<void>;
type Next         = (err?: unknown) => void;       // next("route") skips the rest of the current route
```

### `req`

| member | description |
|---|---|
| `method`, `path`, `originalUrl` | `path` has no query string and is **always the full path**, even inside mounted routers. |
| `params`, `query` | `Record<string, string>`. Query: percent-decoded, `+` → space, repeated key → last wins, flag keys (`?a`) → `""`. |
| `body` | `unknown`; set by `json()` / `urlencoded()` / `text()`; `undefined` if nothing parsed it. |
| `baseUrl` | Mount path of the running handler: `"/api"` for a router mounted at `/api`; for `useAt("/static", …)` middleware it is `"/static"`. |
| `route` | Matched pattern, e.g. `"/users/:id"`. |
| `locals` | `Map<string, unknown>` for passing data between middleware. |
| `get(name)` / `header(name)` | Case-insensitive header lookup. |
| `ip`, `hostname`, `protocol`, `secure`, `xhr`, `is(type)` | `trustProxy` governs the `X-Forwarded-*` headers. |
| `raw` | The underlying Node-compatible `IncomingMessage`. |

### `res`

| member | description |
|---|---|
| `status(code)`, `set(k, v)` / `header`, `get(k)`, `append(k, v)`, `type(t)`, `location(url)` | All chainable except `get`. |
| `send(body)` | `string` → `text/html`, `Buffer` → `application/octet-stream`, `null`/`undefined` → empty, anything else → JSON. An explicit `Content-Type` is always kept. |
| `json(value)`, `text(string)`, `end()` | |
| `sendStatus(code)` | Status with its reason phrase as the body. |
| `redirect(url)` / `redirect(code, url)` | Default 302. |
| `cookie(name, value, opts?)`, `clearCookie(name)` | `maxAge` (seconds), `path`, `domain`, `httpOnly`, `secure`, `sameSite`. Values are URI-encoded. |
| `sendFile(path)` | Returns `false` if the file cannot be read. |
| `locals`, `headersSent`, `statusCode`, `raw` | |

### Middleware

```ts
app.use(json({ limit: 1_000_000 }), urlencoded(), text());       // bodies; default limit 102400 bytes
app.useAt("/assets", serveStatic("./public", { cache: true }));   // static files
```

`serveStatic(root, { cache?, index?, cacheControl? })` serves GET/HEAD, resolves directories to `index.html`, rejects `..`, backslashes and NULs (403/400), sets `Content-Type` from the extension, and falls through to `next()` for missing files. With `cache: true` file contents are kept in a `Map` after the first read.

### Errors

```ts
throw new HttpError(404, "no such user");           // or next(new HttpError(...)); or reject from an async handler
```

The default handler renders `HttpError` as `status` + its message (`text/plain`) and everything else as `500 Internal Server Error`, logging the cause to stderr (unless `silent`) without exposing it. Register `app.onError(...)` for custom rendering.

Built-in responses: unmatched routes → `404 Cannot GET /path`; a `HEAD` request with no `HEAD` route uses the `GET` route; an `OPTIONS` request on a path with other methods → `204` with `Allow`.

---

## 5. Differences from Express and ultimate-express

Intended to be familiar, not a drop-in replacement.

| Area | Express / ultimate-express | huskar | Reason |
|---|---|---|---|
| Error handlers | `app.use((err, req, res, next) => …)` detected by arity | `app.onError(fn)` | `Function.length` is not lowered by scriptc |
| `app.use` | One overloaded method | `use`, `useAt`, `mount` | scriptc rejects `instanceof` on function/class unions |
| Route precedence | Registration order across all patterns | Most specific pattern wins (static > param > wildcard); same-pattern routes merge | Enables the trie + precomputed chains |
| `req.path` in mounted routers | Relative to the mount point | Always the full path; use `req.baseUrl` | Mounts are flattened, with no URL rewriting |
| `req.locals`, `res.locals` | Plain object | `Map<string, unknown>` | `Record<string, unknown>` fields do not compile |
| Query strings | `qs` (nested objects, arrays) | Flat `Record<string,string>`, last duplicate wins | |
| `X-Powered-By` | On by default | Off by default (`poweredBy: true`) | |
| ETag / conditional GET, `res.format`, `req.accepts`, content negotiation | Yes | Not implemented | |
| Route syntax | `:id?`, regex, `app.param` | `:id`, `*` only | Regex-free router |
| Strict routing | Option | Not supported (trailing slashes ignored) | |
| Views, `res.render`, `res.download`, range requests | Yes | Not implemented | |
| Body parsers | `json`, `urlencoded`, `text`, `raw` | `json`, `urlencoded`, `text` | |
| `listen` | `app.listen(port, host?, cb?)` | `listen(port, cb?)` and `listenOn(port, host, cb?)` | Union-typed overloads avoided |
| 405 handling | 404 | 404 | Same |

---

## 6. Benchmarks

### Method

- Tool: [autocannon](https://github.com/mcollina/autocannon), 64 keep-alive connections, 60,000 requests per round, median of 3 rounds after a 20,000-request warm-up.
- **Primary metric: server CPU time per request** (user + sys, read from `/proc/<pid>/stat` before and after each round). On a 2-core machine the load generator is the bottleneck (~20k req/s regardless of server), so throughput would measure autocannon, not the framework. CPU per request is independent of that.
- The server is pinned to core 0 and autocannon to core 1 (`taskset`).
- Identical routes in every target: `/hello`, `/json`, `/users/:id`, a route at position 41 of 44 (to exercise routing with a realistic table), and `POST /echo` (JSON body in, JSON out). All include one global middleware, and Express/ultimate-express have ETag and `x-powered-by` disabled.
- Every round is validated: any error or non-2xx response flags the result invalid. None occurred.

### Results: server CPU per request (µs, lower is better)

| scenario | huskar · scriptc native | huskar · Bun | huskar · Node | ultimate-express · Node | Express · Node | hand-written native¹ |
|---|---:|---:|---:|---:|---:|---:|
| GET /hello (text) | **18.8** | 25.7 | 32.0 | 44.0 | 164.3 | 19.8 |
| GET /json (JSON response) | **19.7** | 27.5 | 35.3 | 50.0 | 163.8 | 20.5 |
| GET /users/:id (param + JSON) | **20.0** | 24.0 | 36.5 | 55.5 | 186.5 | 20.3 |
| GET /r39x/:a/items/:b (route #41 of 44) | **19.7** | 25.0 | 36.3 | 59.0 | 172.3 | 20.2 |
| POST /echo (parse JSON body + JSON response) | **23.5** | 31.0 | 73.3 | 66.5 | 210.5 | 21.3 |

| | huskar · native | huskar · Bun | huskar · Node | ultimate-express | Express |
|---|---:|---:|---:|---:|---:|
| startup to accepting connections (ms) | 7 | 51 | 75 | 151 | 137 |
| RSS after load (MB) | 5 | 55 | 127 | 145 | 136 |

¹ `bench/servers/raw.ts`: the same five routes written directly against `node:http` with no framework, compiled by scriptc. It comes from a second run in the same session (`bench/results-raw.json`; huskar native measured 19.3 / 19.7 / 23.0 / 20.3 / 25.3 µs in that run, so run-to-run noise is about ±2 µs).

**Reading the numbers**

- huskar native vs ultimate-express: **2.3× (hello) to 3.0× (routing at position 41) less CPU per request**. Against Express: **8.3–9.3×**.
- The framework's own overhead is 0–4 µs per request compared with the hand-written server: within noise on `/hello`, `/json` and the deep route, and up to ~4 µs on the param and JSON-body POST routes. Most of the ~19 µs floor is scriptc's `node:http` runtime and the kernel.
- The same huskar source on Bun costs 1.2–1.4× the native CPU; on Node 1.7× (hello) to 3.1× (POST).
- ultimate-express runs on uWebSockets.js (native HTTP parsing), which explains why it is far ahead of Express; huskar native is still ahead of it in every scenario here.

### Caveats (please read)

- One machine: a 2-core Xeon VM at 2.8 GHz, Linux 6.18, 8 GB, single run of the full suite. Absolute numbers will differ on your hardware; I would trust the ratios more than the µs.
- CPU per request includes kernel TCP work, which is identical across targets and compresses the ratios; framework-only differences are larger than the table suggests for the cheap targets.
- Small payloads, HTTP/1.1 keep-alive, localhost, no TLS, no pipelining. Not measured: large bodies, many idle connections, TLS, HTTP/2, multi-core scaling (the server was pinned to a single core), tail latency under saturation.
- "huskar · Bun" uses Bun's `node:http` compatibility layer, not `Bun.serve`, so it says nothing about Bun's best-case HTTP throughput.
- `startup` is spawn-to-first-accepted-connection, median of 7 launches, with a 1 ms poll.

### Reproduce

```
npm install --prefix bench            # express, ultimate-express, autocannon
SCRIPTC=$(which scriptc) node bench/run.mjs                    # everything (~20 min)
node bench/run.mjs --targets huskar-native,express --requests 30000 --rounds 1   # quick
node bench/run.mjs --startup-only
```

Targets: `huskar-native`, `huskar-bun`, `huskar-node`, `raw-native`, `express`, `ultimate`. The Node target is bundled with `bun build --target node`, since Node cannot resolve the extensionless TypeScript imports.

---

## 7. Testing

```
bun test                  # bun target, plus native when scriptc is on PATH
SCRIPTC=/path/to/scriptc bun test
HUSKAR_TARGETS=bun bun test         # or: native
```

`tests/huskar.test.ts` (133 tests) runs **the same assertions twice**: once against `examples/app.ts` running on Bun, once against the same file compiled to a native binary with scriptc. Each target is spawned as a real server on its own port and exercised over HTTP, so the native binary is checked for behavioral parity with a mainstream runtime, not just for "it compiles".

Covered: static / param / multi-param / wildcard routing, static-over-param precedence, case-insensitivity, percent-decoding, trailing and doubled slashes, HEAD and OPTIONS, `app.all`, parameter isolation under 60-way concurrency, query parsing edge cases, the three body parsers (including charset parameters, invalid JSON, 413 over-limit and recovery afterwards), the `res.*` helpers (including `sendFile`, `clearCookie`), cookies, redirects, middleware ordering (before and after routes), `next("route")`, sync and async handler errors, custom and default error handlers, mounted and nested routers (including routes added after `listen`), `app.route`, prefix-scoped middleware on matched and unmatched paths, static files (types, directory index, nested files, HEAD, cache mode, four path-traversal variants sent over a raw socket so the client cannot normalize them), 100 sequential keep-alive requests, and 200 concurrent requests.

Two native-only tests guard the performance design: `examples/app.ts` must report **100% static** in `scriptc coverage`, and none of the hot-path functions may appear in the dynamic-tier list.

---

## 8. Limitations

- **Experimental.** scriptc itself is labelled experimental, and this was developed against 0.4.5 only. Other versions may reject constructs that 0.4.5 accepts, or the reverse.
- Single-process, no clustering. Multi-core behavior of scriptc-compiled servers is untested.
- No HTTPS/TLS, HTTP/2, WebSocket, multipart or streaming-upload helpers (use `req.raw` / `res.raw`).
- No ETag, compression, CORS, sessions, cookie parsing, rate limiting. These are application or middleware concerns.
- Routes: no regex, no optional params, no `app.param`; one most-specific pattern per request. A handler for `/users/me` that calls `next()` does **not** fall through to `/users/:id`.
- `serveStatic` has no range requests, no `ETag`/`Last-Modified`, and reads files synchronously.
- `server.close()` on a scriptc binary lets the process exit about 1–2 s later.

---

## 9. Project layout

```
src/
  index.ts        public exports, huskar(), createRouter()
  router.ts       Router, App: registration, compile(), trie + exact map, Run (chain executor), server glue
  request.ts      Req
  response.ts     Res, mime table, status text
  middleware.ts   json(), urlencoded(), text(), serveStatic()
  types.ts        Handler, ErrorHandler, Next, HttpError, options
  util.ts         regex-free query / decode helpers
examples/app.ts   example app and the test fixture (runs on Bun/Node and compiles with scriptc)
tests/            bun:test suite + static fixtures
bench/            run.mjs, servers/{huskar.ts,express.mjs,ultimate.mjs,raw.ts}, results*.json
```
