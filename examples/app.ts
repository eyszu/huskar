// Fixture + example application. The same file runs on Bun/Node (TS directly) and compiles with scriptc.
//   bun run examples/app.ts 3000
//   scriptc build examples/app.ts -o build/app && ./build/app 3000
import { huskar, createRouter, json, urlencoded, text, serveStatic, HttpError } from "../src/index";

const port = parseInt(process.argv[2] ?? process.env.PORT ?? "3000", 10);
const publicDir = process.argv[3] ?? process.env.PUBLIC_DIR ?? "./tests/public";

const app = huskar({ silent: true, poweredBy: true });

// --- global middleware (runs in registration order) --------------------------------------------
app.use((req, res, next) => {
  res.set("x-request-path", req.path);
  req.locals.set("startedAt", "t0");
  next();
});
app.use(json(), urlencoded(), text());

// --- basic routes -----------------------------------------------------------------------------
app.get("/", (req, res) => { res.send("huskar"); });
app.get("/hello", (req, res) => { res.text("Hello, World!"); });
app.get("/json", (req, res) => { res.json({ message: "Hello, World!", n: 1, ok: true, tags: ["a", "b"] }); });
app.get("/users/:id", (req, res) => { res.json({ id: req.params["id"], route: req.route }); });
app.get("/users/:id/posts/:postId", (req, res) => {
  res.json({ id: req.params["id"], postId: req.params["postId"] });
});
app.get("/users/me", (req, res) => { res.json({ me: true }); }); // static beats :id
app.get("/files/*", (req, res) => { res.json({ rest: req.params["0"] }); });
app.get("/query", (req, res) => { res.json(req.query); });
app.get("/headers", (req, res) => {
  res.json({ ua: req.get("user-agent") ?? null, host: req.hostname, proto: req.protocol, xhr: req.xhr });
});
app.get("/locals", (req, res) => { res.json({ startedAt: req.locals.get("startedAt") ?? null }); });
app.get("/Case/Sensitive", (req, res) => { res.send("matched"); });

// --- bodies -----------------------------------------------------------------------------------
app.post("/echo", (req, res) => { res.json({ body: req.body }); });
app.put("/echo", (req, res) => { res.status(202).json({ body: req.body, method: req.method }); });
app.delete("/things/:id", (req, res) => { res.sendStatus(204); });
app.patch("/things/:id", (req, res) => { res.json({ patched: req.params["id"] }); });

// --- responses --------------------------------------------------------------------------------
app.get("/status/:code", (req, res) => { res.sendStatus(parseInt(req.params["code"], 10)); });
app.get("/redirect", (req, res) => { res.redirect("/hello"); });
app.get("/redirect301", (req, res) => { res.redirect(301, "/json"); });
app.get("/cookie", (req, res) => {
  res.cookie("a", "1 2", { httpOnly: true, maxAge: 60 }).cookie("b", "x").send("cookies");
});
app.get("/sendfile", (req, res) => { if (!res.sendFile(publicDir + "/style.css")) res.sendStatus(404); });
app.get("/sendfile-missing", (req, res) => { if (!res.sendFile(publicDir + "/nope.css")) res.sendStatus(404); });
app.get("/clear-cookie", (req, res) => { res.clearCookie("a").location("/elsewhere").status(200).send("cleared"); });
app.get("/type", (req, res) => { res.type("json").send("{\"raw\":true}"); });
app.get("/custom-header", (req, res) => { res.set("x-custom", "yes").append("x-multi", "a").append("x-multi", "b").send("ok"); });
app.get("/buffer", (req, res) => { res.send(Buffer.from("binary!")); });
app.get("/null", (req, res) => { res.send(null); });

// --- control flow: next, async, errors --------------------------------------------------------
app.get(
  "/chain",
  (req, res, next) => { req.locals.set("step", "one"); next(); },
  (req, res) => { res.json({ step: req.locals.get("step") }); },
);
app.get("/skip", (req, res, next) => { next("route"); }, (req, res) => { res.send("never"); });
app.get("/skip", (req, res) => { res.send("second route"); });
app.get("/async", async (req, res) => {
  await Promise.resolve(1);
  res.json({ async: true });
});
app.get("/async-fail", async (req, res) => {
  await Promise.resolve(1);
  throw new HttpError(418, "teapot");
});
app.get("/throw", (req, res) => { throw new Error("boom"); });
app.get("/http-error", (req, res, next) => { next(new HttpError(403, "nope")); });
app.get("/handled", (req, res) => { throw new HttpError(409, "conflict"); });

// --- routers ----------------------------------------------------------------------------------
const api = createRouter();
api.use((req, res, next) => { res.set("x-api", "1"); next(); });
api.get("/ping", (req, res) => { res.json({ pong: true, base: req.baseUrl }); });
api.get("/items/:id", (req, res) => { res.json({ item: req.params["id"], base: req.baseUrl }); });
api.route("/chained").get((req, res) => { res.send("chained get"); }).post((req, res) => { res.send("chained post"); });
const v1 = createRouter();
v1.get("/deep", (req, res) => { res.json({ deep: true, base: req.baseUrl }); });
api.mount("/v1", v1);
app.mount("/api", api);

app.useAt("/guarded", (req, res, next) => {
  if (req.get("x-token") !== "secret") { next(new HttpError(401, "unauthorized")); return; }
  next();
});
app.get("/guarded/data", (req, res) => { res.json({ secret: 42 }); });
app.get("/open/data", (req, res) => { res.json({ secret: 0 }); });
app.all("/any", (req, res) => { res.send("any:" + req.method); });

// --- static files -----------------------------------------------------------------------------
app.useAt("/static", serveStatic(publicDir));
app.useAt("/cached", serveStatic(publicDir, { cache: true }));

// --- error handler: only for /handled; everything else uses the default ------------------------
app.onError((err, req, res, next) => {
  if (req.path === "/handled" && err instanceof HttpError) {
    res.status(err.status).json({ handled: true, message: err.message });
    return;
  }
  next(err);
});

// --- middleware registered AFTER routes: only runs when a route falls through or nothing matched ---------
app.get("/fallthrough", (req, res, next) => { next(); });
app.use((req, res, next) => { res.set("x-after", "1"); next(); });

app.listen(port, () => console.log("huskar listening on " + port));

// routes added to a mounted router after listen() are picked up (the app recompiles lazily)
api.get("/late", (req, res) => { res.json({ late: true, base: req.baseUrl }); });
