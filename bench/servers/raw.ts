// Hand-written node:http server with the same five routes and no framework: the floor for "framework overhead".
import * as http from "node:http";

const port = parseInt(process.argv[2] ?? "3000", 10);

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "POST" && url === "/echo") {
    const chunks: string[] = [];
    req.setEncoding("utf8");
    req.on("data", (c: string) => { chunks.push(c); });
    req.on("end", () => {
      const body: unknown = JSON.parse(chunks.join(""));
      res.setHeader("x-bench", "1");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ body }));
    });
    return;
  }
  res.setHeader("x-bench", "1");
  if (url === "/hello") {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Hello, World!");
  } else if (url === "/json") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ message: "Hello, World!", n: 42, ok: true, tags: ["a", "b", "c"] }));
  } else if (url.startsWith("/users/")) {
    const id = url.slice(7);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ id, name: "user-" + id, active: true }));
  } else if (url.startsWith("/r39x/")) {
    const parts = url.split("/");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ a: parts[2], b: parts[4], last: true }));
  } else {
    res.statusCode = 404;
    res.end("Not Found");
  }
});
server.listen(port, () => console.log("ready"));
