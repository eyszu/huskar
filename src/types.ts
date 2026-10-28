import type { Req } from "./request";
import type { Res } from "./response";

/** Continue to the next handler. `next(err)` jumps to error handlers; `next("route")` skips the rest of the current route. */
export type Next = (err?: unknown) => void;

/** A request handler or middleware. May be `async`; a rejected promise is routed to the error handlers. */
export type Handler = (req: Req, res: Res, next: Next) => void | Promise<void>;

/** An error handler, registered with `app.onError(...)`. */
export type ErrorHandler = (err: unknown, req: Req, res: Res, next: Next) => void | Promise<void>;

/** An error that carries an HTTP status. Thrown or passed to `next()`, it is rendered by the default error handler. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

export interface AppOptions {
  /** Match routes case-sensitively. Default: false (like Express). */
  caseSensitive?: boolean;
  /** Add `X-Powered-By: huskar` to every response. Default: false. */
  poweredBy?: boolean;
  /** Trust `X-Forwarded-*` headers for `req.ip`, `req.protocol` and `req.hostname`. Default: false. */
  trustProxy?: boolean;
  /** Do not log 5xx errors to stderr. Default: false. */
  silent?: boolean;
}

export interface CookieOptions {
  maxAge?: number; // seconds
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string; // "Lax" | "Strict" | "None"
}
