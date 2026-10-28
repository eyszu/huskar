import * as http from "node:http";
import { parseQueryString, contentTypeIs } from "./util";

export class Req {
  /** The underlying Node-compatible request. */
  raw: http.IncomingMessage;
  method: string;
  /** URL as received, including the query string. */
  originalUrl: string;
  /** Path without the query string. Always the full path, even inside mounted routers. */
  path: string;
  /** The mount prefix of the router that owns the running handler ("" for the app). */
  baseUrl: string = "";
  params: Record<string, string> = {};
  query: Record<string, string> = {};
  /** Set by the body parsers (`json()`, `text()`, `urlencoded()`). `undefined` when nothing was parsed. */
  body: unknown = undefined;
  /** Per-request scratch space for middleware: `req.locals.set("user", u)`. */
  locals: Map<string, unknown> = new Map();
  /** The route pattern that matched, e.g. "/users/:id" ("" when none matched). */
  route: string = "";
  trustProxy: boolean;

  constructor(raw: http.IncomingMessage, path: string, queryString: string, trustProxy: boolean) {
    this.raw = raw;
    this.method = raw.method ?? "GET";
    this.originalUrl = raw.url ?? "/";
    this.path = path;
    this.trustProxy = trustProxy;
    if (queryString.length > 0) parseQueryString(queryString, this.query);
  }

  /** Case-insensitive header lookup. */
  get(name: string): string | undefined {
    return this.raw.headers[name.toLowerCase()] as string | undefined;
  }

  header(name: string): string | undefined {
    return this.get(name);
  }

  get ip(): string {
    if (this.trustProxy) {
      const xff = this.get("x-forwarded-for");
      if (xff !== undefined) {
        const comma = xff.indexOf(",");
        return (comma < 0 ? xff : xff.slice(0, comma)).trim();
      }
    }
    return this.raw.socket.remoteAddress ?? "";
  }

  get hostname(): string {
    let host = this.get("host");
    if (this.trustProxy) {
      const xfh = this.get("x-forwarded-host");
      if (xfh !== undefined) host = xfh;
    }
    if (host === undefined) return "";
    if (host.charCodeAt(0) === 91) {
      const close = host.indexOf("]"); // [::1]:3000
      return close < 0 ? host : host.slice(0, close + 1);
    }
    const colon = host.indexOf(":");
    return colon < 0 ? host : host.slice(0, colon);
  }

  get protocol(): string {
    if (this.trustProxy) {
      const p = this.get("x-forwarded-proto");
      if (p !== undefined) return p.split(",")[0].trim();
    }
    return "http";
  }

  get secure(): boolean {
    return this.protocol === "https";
  }

  get xhr(): boolean {
    const v = this.get("x-requested-with");
    return v !== undefined && v.toLowerCase() === "xmlhttprequest";
  }

  /** `req.is("json")` — does the request Content-Type match? */
  is(kind: string): boolean {
    const ct = this.get("content-type");
    return ct !== undefined && contentTypeIs(ct, kind);
  }
}
