import * as fs from "node:fs";
import type { Handler, Next } from "./types";
import { HttpError } from "./types";
import type { Req } from "./request";
import type { Res } from "./response";
import { mimeForPath } from "./response";
import { contentTypeIs, parseQueryString, safeDecode } from "./util";

export interface BodyOptions {
  /** Maximum body size in bytes. Default: 102400 (100 KiB). Larger bodies fail with 413. */
  limit?: number;
}

const DEFAULT_LIMIT = 102400;

/**
 * Reads the request body as UTF-8 text, then calls `done(text)` — or `fail(err)` on overflow / stream errors.
 * Exactly one of the two callbacks is invoked, exactly once.
 */
function readText(req: Req, limit: number, done: (text: string) => void, fail: (err: HttpError) => void): void {
  const declared = req.get("content-length");
  if (declared !== undefined && parseInt(declared, 10) > limit) {
    fail(new HttpError(413, "Payload Too Large"));
    req.raw.resume();
    return;
  }
  const chunks: string[] = [];
  let size = 0;
  let finished = false;
  req.raw.setEncoding("utf8");
  req.raw.on("data", (chunk: string) => {
    if (finished) return;
    size += Buffer.byteLength(chunk);
    if (size > limit) {
      finished = true;
      fail(new HttpError(413, "Payload Too Large"));
      return;
    }
    chunks.push(chunk);
  });
  req.raw.on("end", () => {
    if (finished) return;
    finished = true;
    done(chunks.join(""));
  });
  req.raw.on("error", () => {
    if (finished) return;
    finished = true;
    fail(new HttpError(400, "Request stream error"));
  });
}

/** Parse `application/json` bodies into `req.body`. Invalid JSON fails with 400. */
export function json(opts?: BodyOptions): Handler {
  const limit = opts !== undefined && opts.limit !== undefined ? opts.limit : DEFAULT_LIMIT;
  return (req: Req, res: Res, next: Next): void => {
    const ct = req.get("content-type");
    if (ct === undefined || !contentTypeIs(ct, "json")) {
      next();
      return;
    }
    readText(
      req,
      limit,
      (text: string) => {
        if (text.length === 0) {
          req.body = {};
          next();
          return;
        }
        let parsed: unknown = undefined;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          next(new HttpError(400, "Invalid JSON"));
          return;
        }
        req.body = parsed;
        next();
      },
      (err: HttpError) => {
        next(err);
      },
    );
  };
}

/** Parse `application/x-www-form-urlencoded` bodies into `req.body` (a flat string map; last duplicate wins). */
export function urlencoded(opts?: BodyOptions): Handler {
  const limit = opts !== undefined && opts.limit !== undefined ? opts.limit : DEFAULT_LIMIT;
  return (req: Req, res: Res, next: Next): void => {
    const ct = req.get("content-type");
    if (ct === undefined || !contentTypeIs(ct, "urlencoded")) {
      next();
      return;
    }
    readText(
      req,
      limit,
      (text: string) => {
        const out: Record<string, string> = {};
        parseQueryString(text, out);
        req.body = out;
        next();
      },
      (err: HttpError) => {
        next(err);
      },
    );
  };
}

/** Read `text/*` bodies into `req.body` as a string. */
export function text(opts?: BodyOptions): Handler {
  const limit = opts !== undefined && opts.limit !== undefined ? opts.limit : DEFAULT_LIMIT;
  return (req: Req, res: Res, next: Next): void => {
    const ct = req.get("content-type");
    if (ct === undefined || !contentTypeIs(ct, "text")) {
      next();
      return;
    }
    readText(
      req,
      limit,
      (body: string) => {
        req.body = body;
        next();
      },
      (err: HttpError) => {
        next(err);
      },
    );
  };
}

export interface StaticOptions {
  /** Keep served files in memory after the first read. Default: false. */
  cache?: boolean;
  /** File served for directory requests. Default: "index.html". */
  index?: string;
  /** Value for the Cache-Control header. Default: "public, max-age=0". */
  cacheControl?: string;
}

/** Serve files from `root` for GET/HEAD requests. Unknown files fall through to `next()`. */
export function serveStatic(root: string, opts?: StaticOptions): Handler {
  const useCache = opts !== undefined && opts.cache === true;
  const indexName = opts !== undefined && opts.index !== undefined ? opts.index : "index.html";
  const cacheControl = opts !== undefined && opts.cacheControl !== undefined ? opts.cacheControl : "public, max-age=0";
  const base = root.length > 1 && root.charCodeAt(root.length - 1) === 47 ? root.slice(0, root.length - 1) : root;
  const cache: Map<string, Buffer> = new Map();

  function load(file: string): Buffer | undefined {
    if (useCache) {
      const hit = cache.get(file);
      if (hit !== undefined) return hit;
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(file);
    } catch (e) {
      return undefined;
    }
    if (useCache) cache.set(file, data);
    return data;
  }

  return (req: Req, res: Res, next: Next): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    let sub = req.path;
    if (req.baseUrl.length > 0 && sub.length >= req.baseUrl.length) sub = sub.slice(req.baseUrl.length);
    const rel = safeDecode(sub.length === 0 ? "/" : sub);
    if (rel.indexOf("\0") >= 0 || rel.indexOf("\\") >= 0) {
      next(new HttpError(400, "Bad Request"));
      return;
    }
    for (const seg of rel.split("/")) {
      if (seg === "..") {
        next(new HttpError(403, "Forbidden"));
        return;
      }
    }
    let file = base + (rel.charCodeAt(0) === 47 ? rel : "/" + rel);
    if (file.charCodeAt(file.length - 1) === 47) file += indexName;
    let servedName = file;
    let data = load(file);
    if (data === undefined) {
      data = load(file + "/" + indexName);
      servedName = indexName;
    }
    if (data === undefined) {
      next();
      return;
    }
    res.set("content-type", mimeForPath(servedName));
    res.set("cache-control", cacheControl);
    res.raw.end(data);
  };
}
