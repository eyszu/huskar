import { App, Router } from "./router";
import type { AppOptions } from "./types";

export { App, Router, RouteBuilder } from "./router";
export { Req } from "./request";
export { Res } from "./response";
export { HttpError } from "./types";
export type { Handler, ErrorHandler, Next, AppOptions, CookieOptions } from "./types";
export { json, urlencoded, text, serveStatic } from "./middleware";
export type { BodyOptions, StaticOptions } from "./middleware";

/** Create an application. */
export function huskar(opts?: AppOptions): App {
  return new App(opts);
}

/** Create a standalone router to mount with `app.mount("/prefix", router)`. */
export function createRouter(): Router {
  return new Router();
}

export default huskar;
