import * as http from "node:http";
import * as fs from "node:fs";
import type { CookieOptions } from "./types";

const MIME: Map<string, string> = new Map([
  ["html", "text/html; charset=utf-8"], ["htm", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"], ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"], ["json", "application/json; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"], ["xml", "application/xml; charset=utf-8"],
  ["svg", "image/svg+xml"], ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["gif", "image/gif"], ["webp", "image/webp"], ["ico", "image/x-icon"],
  ["woff", "font/woff"], ["woff2", "font/woff2"], ["pdf", "application/pdf"],
  ["wasm", "application/wasm"], ["map", "application/json; charset=utf-8"],
]);

const STATUS_TEXT: Map<number, string> = new Map([
  [100, "Continue"], [101, "Switching Protocols"], [200, "OK"], [201, "Created"], [202, "Accepted"],
  [204, "No Content"], [206, "Partial Content"], [301, "Moved Permanently"], [302, "Found"],
  [303, "See Other"], [304, "Not Modified"], [307, "Temporary Redirect"], [308, "Permanent Redirect"],
  [400, "Bad Request"], [401, "Unauthorized"], [403, "Forbidden"], [404, "Not Found"],
  [405, "Method Not Allowed"], [406, "Not Acceptable"], [408, "Request Timeout"], [409, "Conflict"],
  [410, "Gone"], [413, "Payload Too Large"], [415, "Unsupported Media Type"], [418, "I'm a Teapot"],
  [422, "Unprocessable Entity"], [429, "Too Many Requests"], [500, "Internal Server Error"],
  [501, "Not Implemented"], [502, "Bad Gateway"], [503, "Service Unavailable"], [504, "Gateway Timeout"],
]);

/** Reason phrase for a status code ("Not Found"), or the number itself when unknown. */
export function statusText(code: number): string {
  return STATUS_TEXT.get(code) ?? String(code);
}

/** Resolves "json", "html", ".png" or a full MIME type to a Content-Type value. */
export function mimeFor(type: string): string {
  if (type.indexOf("/") >= 0) return type;
  const ext = type.charCodeAt(0) === 46 ? type.slice(1) : type;
  return MIME.get(ext.toLowerCase()) ?? "application/octet-stream";
}

export function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot < 0 || dot < slash) return "application/octet-stream";
  return mimeFor(path.slice(dot + 1));
}

export class Res {
  /** The underlying Node-compatible response. */
  raw: http.ServerResponse;
  locals: Map<string, unknown> = new Map();

  constructor(raw: http.ServerResponse) {
    this.raw = raw;
  }

  get headersSent(): boolean {
    return this.raw.headersSent;
  }

  get statusCode(): number {
    return this.raw.statusCode;
  }

  status(code: number): Res {
    this.raw.statusCode = code;
    return this;
  }

  /** Set a response header (replaces an existing one). */
  set(field: string, value: string): Res {
    this.raw.setHeader(field, value);
    return this;
  }

  header(field: string, value: string): Res {
    return this.set(field, value);
  }

  get(field: string): string | undefined {
    const v = this.raw.getHeader(field);
    if (v === undefined) return undefined;
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return v.join(", ");
  }

  /** Append to a header, keeping any existing value. */
  append(field: string, value: string): Res {
    const prev = this.get(field);
    this.raw.setHeader(field, prev === undefined ? value : prev + ", " + value);
    return this;
  }

  /** `res.type("json")`, `res.type(".png")`, `res.type("text/csv")`. */
  type(t: string): Res {
    this.raw.setHeader("content-type", mimeFor(t));
    return this;
  }

  location(url: string): Res {
    this.raw.setHeader("location", url);
    return this;
  }

  /**
   * Send a response body. Strings default to text/html, Buffers to application/octet-stream,
   * anything else is serialized as JSON. An explicit Content-Type is always respected.
   */
  send(body: unknown): void {
    if (typeof body === "string") {
      if (this.raw.getHeader("content-type") === undefined) {
        this.raw.setHeader("content-type", "text/html; charset=utf-8");
      }
      this.raw.end(body);
    } else if (body === undefined || body === null) {
      this.raw.end();
    } else if (body instanceof Uint8Array) {
      if (this.raw.getHeader("content-type") === undefined) {
        this.raw.setHeader("content-type", "application/octet-stream");
      }
      this.raw.end(body);
    } else {
      this.json(body);
    }
  }

  /** Serialize `body` as JSON. Uses the runtime's native JSON.stringify. */
  json(body: unknown): void {
    if (this.raw.getHeader("content-type") === undefined) {
      this.raw.setHeader("content-type", "application/json; charset=utf-8");
    }
    this.raw.end(JSON.stringify(body));
  }

  /** Send plain text. */
  text(body: string): void {
    if (this.raw.getHeader("content-type") === undefined) {
      this.raw.setHeader("content-type", "text/plain; charset=utf-8");
    }
    this.raw.end(body);
  }

  end(): void {
    this.raw.end();
  }

  /** Status code plus its reason phrase as the body: `res.sendStatus(404)` → "Not Found". */
  sendStatus(code: number): void {
    this.raw.statusCode = code;
    this.raw.setHeader("content-type", "text/plain; charset=utf-8");
    this.raw.end(statusText(code));
  }

  redirect(url: string): void;
  redirect(code: number, url: string): void;
  redirect(a: number | string, b?: string): void {
    let code = 302;
    let url = "";
    if (typeof a === "number") {
      code = a;
      url = b ?? "";
    } else {
      url = a;
    }
    this.raw.statusCode = code;
    this.raw.setHeader("location", url);
    this.raw.setHeader("content-type", "text/plain; charset=utf-8");
    this.raw.end(statusText(code) + ". Redirecting to " + url);
  }

  cookie(name: string, value: string, opts?: CookieOptions): Res {
    let c = name + "=" + encodeURIComponent(value);
    if (opts !== undefined) {
      if (opts.maxAge !== undefined) c += "; Max-Age=" + Math.floor(opts.maxAge);
      c += "; Path=" + (opts.path ?? "/");
      if (opts.domain !== undefined) c += "; Domain=" + opts.domain;
      if (opts.httpOnly === true) c += "; HttpOnly";
      if (opts.secure === true) c += "; Secure";
      if (opts.sameSite !== undefined) c += "; SameSite=" + opts.sameSite;
    } else {
      c += "; Path=/";
    }
    const prev = this.raw.getHeader("set-cookie");
    if (prev === undefined) {
      this.raw.setHeader("set-cookie", [c]);
    } else if (typeof prev === "string") {
      this.raw.setHeader("set-cookie", [prev, c]);
    } else if (typeof prev !== "number") {
      const list: string[] = [];
      for (const p of prev) list.push(p);
      list.push(c);
      this.raw.setHeader("set-cookie", list);
    }
    return this;
  }

  clearCookie(name: string): Res {
    return this.cookie(name, "", { maxAge: 0 });
  }

  /** Send a file from disk. Returns false (and sends nothing) when the file cannot be read. */
  sendFile(path: string): boolean {
    let data: Buffer;
    try {
      data = fs.readFileSync(path);
    } catch (e) {
      return false;
    }
    if (this.raw.getHeader("content-type") === undefined) {
      this.raw.setHeader("content-type", mimeForPath(path));
    }
    this.raw.end(data);
    return true;
  }
}
