// Benchmark app for huskar. Same routes as express.mjs / ultimate.mjs.
import { huskar, json } from "../../src/index";

const port = parseInt(process.argv[2] ?? "3000", 10);
const app = huskar();

app.use((req, res, next) => { res.set("x-bench", "1"); next(); });
app.use(json());

app.get("/hello", (req, res) => { res.text("Hello, World!"); });
app.get("/json", (req, res) => { res.json({ message: "Hello, World!", n: 42, ok: true, tags: ["a", "b", "c"] }); });
app.get("/users/:id", (req, res) => { res.json({ id: req.params["id"], name: "user-" + req.params["id"], active: true }); });
app.post("/echo", (req, res) => { res.json({ body: req.body }); });

// 40 extra routes so routing has real work to do
for (let i = 0; i < 40; i++) {
  app.get("/r" + i + "/:a/items/:b", (req, res) => { res.json({ a: req.params["a"], b: req.params["b"] }); });
}
app.get("/r39x/:a/items/:b", (req, res) => { res.json({ a: req.params["a"], b: req.params["b"], last: true }); });

app.listen(port, () => console.log("ready"));
