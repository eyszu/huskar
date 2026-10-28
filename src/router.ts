import * as http from "node:http";
import { Req } from "./request";
import { Res, statusText } from "./response";
import { HttpError } from "./types";
import type { Handler, ErrorHandler, Next, AppOptions } from "./types";
import { safeDecode, parseQueryString } from "./util";

// ---------------------------------------------------------------------------------------------
// Registration model (what the user builds) -> compiled model (what requests run against).
//
//   app.use / app.get / router mounts  ──compile()──▶  flat layer list
//                                                      ├─ one Route per (method, pattern)
//                                                      │    with its middleware chain precomputed
//                                                      ├─ exact-path Map per method   (O(1) hot path)
//                                                      └─ segment trie per method     (params, wildcards)
// ---------------------------------------------------------------------------------------------

const KIND_USE = 0;
const KIND_ROUTE = 1;
const KIND_MOUNT = 2;
const KIND_ERROR = 3;

const METHODS: string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

class Layer {
  kind: number;
  method: string; // "" = every method
  path: string; // route pattern, or mount/use prefix ("" = everything)
  handlers: Handler[] = [];
  errHandler: ErrorHandler | null = null;
  child: Router | null = null;
  constructor(kind: number, method: string, path: string) {
    this.kind = kind;
    this.method = method;
    this.path = path;
  }
}

/** One step of a compiled chain. */
class Entry {
  h: Handler | null;
  eh: ErrorHandler | null;
  routeId: number; // layer index of the owning route (-1 for middleware); used by next("route")
  guard: string; // when non-empty, only run if the request path starts with this prefix
  base: string; // mount prefix exposed as req.baseUrl
  constructor(h: Handler | null, eh: ErrorHandler | null, routeId: number, guard: string, base: string) {
    this.h = h;
    this.eh = eh;
    this.routeId = routeId;
    this.guard = guard;
    this.base = base;
  }
}

class Route {
  method: string;
  pattern: string;
  paramNames: string[] = [];
  chain: Entry[] = [];
  constructor(method: string, pattern: string) {
    this.method = method;
    this.pattern = pattern;
  }
}

class TrieNode {
  statics: Map<string, TrieNode> = new Map();
  param: TrieNode | null = null;
  route: Route | null = null; // pattern ends here
  wild: Route | null = null; // pattern ends with `*` here
}

/** A flattened (mount-expanded) layer. */
class Flat {
  kind: number;
  method: string;
  pattern: string;
  base: string;
  layer: Layer;
  constructor(kind: number, method: string, pattern: string, base: string, layer: Layer) {
    this.kind = kind;
    this.method = method;
    this.pattern = pattern;
    this.base = base;
    this.layer = layer;
  }
}

function joinPath(prefix: string, path: string): string {
  let p = path;
  if (p.length > 1 && p.charCodeAt(p.length - 1) === 47) p = p.slice(0, p.length - 1);
  if (prefix.length === 0) return p;
  if (p.length === 0 || p === "/") return prefix;
  return prefix + (p.charCodeAt(0) === 47 ? p : "/" + p);
}

function normalizePattern(path: string): string {
  if (path.length === 0 || path === "*") return path === "*" ? "/*" : "";
  let p = path.charCodeAt(0) === 47 ? path : "/" + path;
  if (p.length > 1 && p.charCodeAt(p.length - 1) === 47) p = p.slice(0, p.length - 1);
  return p;
}

function splitSegments(path: string): string[] {
  const out: string[] = [];
  const n = path.length;
  let pos = 0;
  while (pos < n) {
    while (pos < n && path.charCodeAt(pos) === 47) pos++;
    if (pos >= n) break;
    let end = path.indexOf("/", pos);
    if (end < 0) end = n;
    out.push(path.slice(pos, end));
    pos = end;
  }
  return out;
}

function isDynamicSegment(seg: string): boolean {
  const c = seg.charCodeAt(0);
  return c === 58 || c === 42; // ':' or '*'
}

export class Router {
  stack: Layer[] = [];
  /** Routers/apps this router is mounted in; a change here must invalidate their compiled form. */
  owners: Router[] = [];
  private touching: boolean = false;

  // ---- registration -------------------------------------------------------------------------

  private addRoute(method: string, path: string, handlers: Handler[]): void {
    const l = new Layer(KIND_ROUTE, method, normalizePattern(path));
    for (const h of handlers) l.handlers.push(h);
    this.stack.push(l);
    this.touch();
  }

  /** Called whenever the stack changes so every app this router is mounted in recompiles. */
  touch(): void {
    if (this.touching) return; // mount cycle guard
    this.touching = true;
    for (const o of this.owners) o.touch();
    this.touching = false;
  }

  get(path: string, ...handlers: Handler[]): Router { this.addRoute("GET", path, handlers); return this; }
  post(path: string, ...handlers: Handler[]): Router { this.addRoute("POST", path, handlers); return this; }
  put(path: string, ...handlers: Handler[]): Router { this.addRoute("PUT", path, handlers); return this; }
  patch(path: string, ...handlers: Handler[]): Router { this.addRoute("PATCH", path, handlers); return this; }
  delete(path: string, ...handlers: Handler[]): Router { this.addRoute("DELETE", path, handlers); return this; }
  head(path: string, ...handlers: Handler[]): Router { this.addRoute("HEAD", path, handlers); return this; }
  options(path: string, ...handlers: Handler[]): Router { this.addRoute("OPTIONS", path, handlers); return this; }
  all(path: string, ...handlers: Handler[]): Router { this.addRoute("", path, handlers); return this; }

  /** Middleware for every request: `app.use(mw)`. */
  use(...handlers: Handler[]): Router {
    const l = new Layer(KIND_USE, "", "");
    for (const h of handlers) l.handlers.push(h);
    this.stack.push(l);
    this.touch();
    return this;
  }

  /** Middleware for a path prefix: `app.use("/api", mw)`. */
  useAt(path: string, ...handlers: Handler[]): Router {
    const l = new Layer(KIND_USE, "", normalizePattern(path));
    for (const h of handlers) l.handlers.push(h);
    this.stack.push(l);
    this.touch();
    return this;
  }

  /** Mount a router (or app) at a prefix: `app.mount("/api", apiRouter)`. Mounts are flattened at compile time. */
  mount(path: string, child: Router): Router {
    const l = new Layer(KIND_MOUNT, "", normalizePattern(path));
    l.child = child;
    child.owners.push(this);
    this.stack.push(l);
    this.touch();
    return this;
  }

  /** Register an error handler. Runs when a handler throws, rejects, or calls `next(err)`. */
  onError(handler: ErrorHandler): Router {
    const l = new Layer(KIND_ERROR, "", "");
    l.errHandler = handler;
    this.stack.push(l);
    this.touch();
    return this;
  }

  /** `app.route("/x").get(h).post(h)` */
  route(path: string): RouteBuilder {
    return new RouteBuilder(this, path);
  }

  addFor(method: string, path: string, handlers: Handler[]): void {
    this.addRoute(method, path, handlers);
  }

  flattenInto(out: Flat[], prefix: string, depth: number): void {
    if (depth > 16) throw new Error("huskar: router mounts nested too deeply (cycle?)");
    for (const l of this.stack) {
      if (l.kind === KIND_MOUNT) {
        const child = l.child;
        if (child !== null) child.flattenInto(out, joinPath(prefix, l.path), depth + 1);
      } else if (l.kind === KIND_ROUTE) {
        out.push(new Flat(KIND_ROUTE, l.method, joinPath(prefix, l.path), prefix, l));
      } else {
        out.push(new Flat(l.kind, "", l.path.length === 0 ? prefix : joinPath(prefix, l.path), prefix, l));
      }
    }
  }
}

export class RouteBuilder {
  router: Router;
  path: string;
  constructor(router: Router, path: string) {
    this.router = router;
    this.path = path;
  }
  get(...h: Handler[]): RouteBuilder { this.router.addFor("GET", this.path, h); return this; }
  post(...h: Handler[]): RouteBuilder { this.router.addFor("POST", this.path, h); return this; }
  put(...h: Handler[]): RouteBuilder { this.router.addFor("PUT", this.path, h); return this; }
  patch(...h: Handler[]): RouteBuilder { this.router.addFor("PATCH", this.path, h); return this; }
  delete(...h: Handler[]): RouteBuilder { this.router.addFor("DELETE", this.path, h); return this; }
  all(...h: Handler[]): RouteBuilder { this.router.addFor("", this.path, h); return this; }
}

// ---------------------------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------------------------

class Run {
  chain: Entry[];
  i: number = -1;
  req: Req;
  res: Res;
  app: App;
  next: Next;

  constructor(app: App, chain: Entry[], req: Req, res: Res) {
    this.app = app;
    this.chain = chain;
    this.req = req;
    this.res = res;
    this.next = (err?: unknown) => {
      this.advance(err);
    };
  }

  advance(err: unknown): void {
    let e: unknown = err === null ? undefined : err;
    let skip = -2;
    if (typeof e === "string" && e === "route") {
      const cur = this.i >= 0 && this.i < this.chain.length ? this.chain[this.i].routeId : -1;
      skip = cur;
      e = undefined;
    }
    const chain = this.chain;
    const n = chain.length;
    while (true) {
      this.i++;
      if (this.i >= n) break;
      const en = chain[this.i];
      if (skip >= 0 && en.routeId === skip) continue;
      if (en.guard.length > 0 && !this.app.prefixMatch(this.req.path, en.guard)) continue;
      if (e !== undefined) {
        const eh = en.eh;
        if (eh === null) continue;
        this.callError(eh, en, e);
        return;
      }
      const h = en.h;
      if (h === null) continue;
      this.call(h, en);
      return;
    }
    if (e !== undefined) this.app.defaultError(e, this.req, this.res);
    else this.app.notFound(this.req, this.res);
  }

  call(h: Handler, en: Entry): void {
    this.req.baseUrl = en.base;
    try {
      const r = h(this.req, this.res, this.next);
      if (r instanceof Promise) {
        r.catch((ex: unknown) => {
          this.advance(ex);
        });
      }
    } catch (ex) {
      this.advance(ex);
    }
  }

  callError(eh: ErrorHandler, en: Entry, err: unknown): void {
    this.req.baseUrl = en.base;
    try {
      const r = eh(err, this.req, this.res, this.next);
      if (r instanceof Promise) {
        r.catch((ex: unknown) => {
          this.app.defaultError(ex, this.req, this.res);
        });
      }
    } catch (ex) {
      this.app.defaultError(ex, this.req, this.res);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

export class App extends Router {
  caseSensitive: boolean;
  poweredBy: boolean;
  trustProxy: boolean;
  silent: boolean;
  server: http.Server | null = null;

  private dirty: boolean = true;
  private exact: Map<string, Map<string, Route>> = new Map();
  private tries: Map<string, TrieNode> = new Map();
  private fallback: Entry[] = [];
  private scratch: string[] = [];

  constructor(opts?: AppOptions) {
    super();
    this.caseSensitive = opts !== undefined && opts.caseSensitive === true;
    this.poweredBy = opts !== undefined && opts.poweredBy === true;
    this.trustProxy = opts !== undefined && opts.trustProxy === true;
    this.silent = opts !== undefined && opts.silent === true;
  }

  touch(): void {
    this.dirty = true;
    super.touch();
  }

  // ---- compile ------------------------------------------------------------------------------

  /** Flatten mounts, build one Route per (method, pattern) with its chain precomputed, and index them. */
  compile(): void {
    const flat: Flat[] = [];
    this.flattenInto(flat, "", 0);

    this.exact = new Map();
    this.tries = new Map();
    for (const m of METHODS) {
      this.exact.set(m, new Map());
      this.tries.set(m, new TrieNode());
    }

    const routes: Route[] = [];
    const seen: Map<string, Route> = new Map();
    for (const f of flat) {
      if (f.kind !== KIND_ROUTE) continue;
      const methods = f.method.length === 0 ? METHODS : [f.method];
      for (const m of methods) {
        const key = m + " " + this.key(f.pattern);
        if (seen.has(key)) continue;
        const r = new Route(m, f.pattern);
        seen.set(key, r);
        routes.push(r);
      }
    }

    for (const r of routes) {
      this.buildChain(r, flat);
      this.index(r);
    }

    // chain for requests that match no route: only guarded middleware and error handlers
    this.fallback = [];
    for (let i = 0; i < flat.length; i++) {
      const f = flat[i];
      if (f.kind === KIND_ROUTE) continue;
      this.pushEntries(this.fallback, f, -1, f.pattern === "/" ? "" : f.pattern);
    }
    this.dirty = false;
  }

  private key(pattern: string): string {
    return this.caseSensitive ? pattern : pattern.toLowerCase();
  }

  private pushEntries(chain: Entry[], f: Flat, routeId: number, guard: string): void {
    if (f.kind === KIND_ERROR) {
      chain.push(new Entry(null, f.layer.errHandler, -1, guard, f.base));
    } else {
      // middleware sees its own mount path as req.baseUrl (so serveStatic can strip it); routes see their router's
      const base = f.kind === KIND_USE && f.pattern !== "/" ? f.pattern : f.base;
      for (const h of f.layer.handlers) chain.push(new Entry(h, null, routeId, guard, base));
    }
  }

  /** 0 = prefix never applies to pattern, 1 = always applies, 2 = depends on the concrete path. */
  private prefixRelation(prefix: string, pattern: string): number {
    if (prefix.length === 0 || prefix === "/") return 1;
    const ps = splitSegments(prefix);
    const rs = splitSegments(pattern);
    let maybe = false;
    for (let i = 0; i < ps.length; i++) {
      if (i >= rs.length) return 0;
      const a = ps[i];
      const b = rs[i];
      if (isDynamicSegment(a) || isDynamicSegment(b)) {
        maybe = true;
        continue;
      }
      if (this.caseSensitive ? a !== b : a.toLowerCase() !== b.toLowerCase()) return 0;
    }
    return maybe ? 2 : 1;
  }

  private buildChain(route: Route, flat: Flat[]): void {
    const rkey = this.key(route.pattern);
    for (const s of splitSegments(route.pattern)) {
      if (s.charCodeAt(0) === 58) route.paramNames.push(s.slice(1));
      else if (s.charCodeAt(0) === 42) route.paramNames.push("0");
    }
    for (let i = 0; i < flat.length; i++) {
      const f = flat[i];
      if (f.kind === KIND_ROUTE) {
        if (this.key(f.pattern) !== rkey) continue;
        if (f.method.length !== 0 && f.method !== route.method) continue;
        this.pushEntries(route.chain, f, i, "");
      } else {
        const rel = this.prefixRelation(f.pattern, route.pattern);
        if (rel === 0) continue;
        this.pushEntries(route.chain, f, -1, rel === 1 ? "" : f.pattern);
      }
    }
  }

  private index(route: Route): void {
    const segs = splitSegments(route.pattern);
    let isStatic = true;
    for (const s of segs) if (isDynamicSegment(s)) isStatic = false;
    if (isStatic) {
      const m = this.exact.get(route.method);
      if (m !== undefined) m.set(route.pattern.length === 0 ? "/" : this.key(route.pattern), route);
    }
    let node = this.tries.get(route.method);
    if (node === undefined) return;
    for (const s of segs) {
      const c = s.charCodeAt(0);
      if (c === 42) {
        node.wild = route;
        return;
      }
      if (c === 58) {
        if (node.param === null) node.param = new TrieNode();
        node = node.param;
      } else {
        const k = this.caseSensitive ? s : s.toLowerCase();
        let child = node.statics.get(k);
        if (child === undefined) {
          child = new TrieNode();
          node.statics.set(k, child);
        }
        node = child;
      }
    }
    node.route = route;
  }

  // ---- matching -----------------------------------------------------------------------------

  prefixMatch(path: string, prefix: string): boolean {
    const n = prefix.length;
    if (path.length < n) return false;
    const head = path.slice(0, n);
    if (this.caseSensitive ? head !== prefix : head.toLowerCase() !== prefix.toLowerCase()) return false;
    return path.length === n || path.charCodeAt(n) === 47;
  }

  private matchNode(node: TrieNode, path: string, pos: number): Route | null {
    const n = path.length;
    while (pos < n && path.charCodeAt(pos) === 47) pos++;
    if (pos >= n) return node.route;
    let end = path.indexOf("/", pos);
    if (end < 0) end = n;
    const seg = path.slice(pos, end);
    const c = node.statics.get(this.caseSensitive ? seg : seg.toLowerCase());
    if (c !== undefined) {
      const r = this.matchNode(c, path, end);
      if (r !== null) return r;
    }
    const p = node.param;
    if (p !== null) {
      this.scratch.push(seg);
      const r = this.matchNode(p, path, end);
      if (r !== null) return r;
      this.scratch.pop();
    }
    const w = node.wild;
    if (w !== null) {
      this.scratch.push(path.slice(pos));
      return w;
    }
    return null;
  }

  private lookup(method: string, path: string, req: Req | null): Route | null {
    const ex = this.exact.get(method);
    if (ex === undefined) return null;
    const hit = ex.get(path);
    if (hit !== undefined) return hit;
    const trie = this.tries.get(method);
    if (trie === undefined) return null;
    this.scratch.length = 0;
    const r = this.matchNode(trie, path, 0);
    if (r === null) return null;
    if (req !== null) {
      const params: Record<string, string> = req.params;
      const vals = this.scratch;
      let i = 0;
      // for...of + an explicit undefined check keeps these indexed reads on scriptc's static path
      for (const name of r.paramNames) {
        const value = vals[i];
        if (value === undefined) break;
        params[name] = safeDecode(value);
        i++;
      }
    }
    return r;
  }

  // ---- request handling ---------------------------------------------------------------------

  handle(rawReq: http.IncomingMessage, rawRes: http.ServerResponse): void {
    if (this.dirty) this.compile();
    const url = rawReq.url ?? "/";
    const qi = url.indexOf("?");
    const path = qi < 0 ? url : url.slice(0, qi);
    const req = new Req(rawReq, path, qi < 0 ? "" : url.slice(qi + 1), this.trustProxy);
    const res = new Res(rawRes);
    if (this.poweredBy) rawRes.setHeader("x-powered-by", "huskar");

    const method = req.method;
    let route = this.lookup(method, path, req);
    if (route === null && method === "HEAD") route = this.lookup("GET", path, req);
    if (route === null) {
      if (method === "OPTIONS" && this.autoOptions(req, res)) return;
      new Run(this, this.fallback, req, res).advance(undefined);
      return;
    }
    req.route = route.pattern;
    new Run(this, route.chain, req, res).advance(undefined);
  }

  /** Default OPTIONS reply: 204 with an Allow header, when any method matches the path. */
  private autoOptions(req: Req, res: Res): boolean {
    const allowed: string[] = [];
    for (const m of METHODS) {
      if (m === "OPTIONS") continue;
      if (this.lookup(m, req.path, null) !== null) allowed.push(m);
    }
    if (allowed.length === 0) return false;
    if (allowed.indexOf("GET") >= 0 && allowed.indexOf("HEAD") < 0) allowed.push("HEAD");
    allowed.push("OPTIONS");
    res.status(204).set("allow", allowed.join(","));
    res.end();
    return true;
  }

  notFound(req: Req, res: Res): void {
    if (res.headersSent) return;
    res.status(404).text("Cannot " + req.method + " " + req.path);
  }

  defaultError(err: unknown, req: Req, res: Res): void {
    let status = 500;
    let message = "Internal Server Error";
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message.length > 0 ? err.message : statusText(status);
    } else if (err instanceof Error) {
      if (!this.silent) console.error("huskar: " + req.method + " " + req.path + " failed: " + err.message);
    } else if (!this.silent) {
      console.error("huskar: " + req.method + " " + req.path + " failed with a non-Error value");
    }
    if (res.headersSent) {
      res.raw.end();
      return;
    }
    res.status(status).text(message);
  }

  // ---- server -------------------------------------------------------------------------------

  /** Build the Node-compatible server without listening (useful for tests and custom hosts). */
  createServer(): http.Server {
    this.compile();
    const server = http.createServer((rq, rs) => {
      this.handle(rq, rs);
    });
    this.server = server;
    return server;
  }

  listen(port: number, callback?: () => void): http.Server {
    const server = this.createServer();
    server.listen(port, () => {
      if (callback !== undefined) callback();
    });
    return server;
  }

  /** Listen on a specific interface, e.g. `listenOn(3000, "127.0.0.1", cb)`. */
  listenOn(port: number, host: string, callback?: () => void): http.Server {
    const server = this.createServer();
    server.listen(port, host, () => {
      if (callback !== undefined) callback();
    });
    return server;
  }

  close(): void {
    if (this.server !== null) this.server.close();
  }
}
