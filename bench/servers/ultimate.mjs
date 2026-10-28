import express from "ultimate-express";
const port = parseInt(process.argv[2] ?? "3000", 10);
const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.use((req, res, next) => { res.set("x-bench", "1"); next(); });
app.use(express.json());
app.get("/hello", (req, res) => { res.type("text/plain").send("Hello, World!"); });
app.get("/json", (req, res) => { res.json({ message: "Hello, World!", n: 42, ok: true, tags: ["a", "b", "c"] }); });
app.get("/users/:id", (req, res) => { res.json({ id: req.params.id, name: "user-" + req.params.id, active: true }); });
app.post("/echo", (req, res) => { res.json({ body: req.body }); });
for (let i = 0; i < 40; i++) {
  app.get("/r" + i + "/:a/items/:b", (req, res) => { res.json({ a: req.params.a, b: req.params.b }); });
}
app.get("/r39x/:a/items/:b", (req, res) => { res.json({ a: req.params.a, b: req.params.b, last: true }); });
app.listen(port, () => console.log("ready"));
