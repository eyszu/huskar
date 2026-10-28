#!/usr/bin/env node
// Measures server-side CPU cost per request (the metric that is not capped by the load generator),
// plus throughput and memory, for huskar (native / Bun / Node), Express and ultimate-express.
//
//   node bench/run.mjs                  # all scenarios, all available targets
//   node bench/run.mjs --requests 100000 --connections 64
//   node bench/run.mjs --targets huskar-native,express
//   SCRIPTC=/path/to/scriptc node bench/run.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const BUILD = path.join(ROOT, "build");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const REQUESTS = parseInt(opt("requests", "120000"), 10);
const CONNECTIONS = parseInt(opt("connections", "64"), 10);
const ROUNDS = parseInt(opt("rounds", "3"), 10);
const startupOnly = args.includes("--startup-only");
const only = opt("targets", "").split(",").filter(Boolean);
const outFile = path.resolve(opt("out", path.join(ROOT, "bench", "results.json")));

const scriptc = process.env.SCRIPTC || "scriptc";
const haveCores = os.cpus().length >= 2 && spawnSync("taskset", ["-V"]).status === 0;
const pin = (core, cmd, argv) => (haveCores ? ["taskset", ["-c", String(core), cmd, ...argv]] : [cmd, argv]);

fs.mkdirSync(BUILD, { recursive: true });

// ---------------------------------------------------------------- targets
const targets = [];
function addTarget(id, label, prepare, command) {
  if (only.length && !only.includes(id)) return;
  try {
    prepare();
    targets.push({ id, label, command });
  } catch (e) {
    console.log(`- skipping ${label}: ${e.message.split("\n")[0]}`);
  }
}

addTarget("huskar-native", "huskar (scriptc native)", () => {
  const r = spawnSync(scriptc, ["build", "bench/servers/huskar.ts", "-o", "build/bench-huskar"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error("scriptc build failed: " + (r.stderr || r.stdout || r.error));
}, (port) => [path.join(BUILD, "bench-huskar"), [String(port)]]);

addTarget("raw-native", "hand-written node:http (scriptc native)", () => {
  const r = spawnSync(scriptc, ["build", "bench/servers/raw.ts", "-o", "build/bench-raw"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error("scriptc build failed: " + (r.stderr || r.stdout || r.error));
}, (port) => [path.join(BUILD, "bench-raw"), [String(port)]]);

addTarget("huskar-bun", "huskar (Bun)", () => {
  if (spawnSync("bun", ["--version"]).status !== 0) throw new Error("bun not found");
}, (port) => ["bun", ["run", "bench/servers/huskar.ts", String(port)]]);

addTarget("huskar-node", "huskar (Node)", () => {
  const r = spawnSync("bun", ["build", "bench/servers/huskar.ts", "--target", "node", "--outfile", "build/bench-huskar-node.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error("bun build failed (needed to bundle for Node)");
}, (port) => ["node", [path.join(BUILD, "bench-huskar-node.mjs"), String(port)]]);

addTarget("express", "Express (Node)", () => { require.resolve("express"); },
  (port) => ["node", [path.join(HERE, "servers", "express.mjs"), String(port)]]);

addTarget("ultimate", "ultimate-express (Node)", () => {
  const r = spawnSync("node", ["-e", "require('ultimate-express')"], { cwd: HERE, encoding: "utf8" });
  if (r.status !== 0) throw new Error("ultimate-express/uWebSockets.js did not load");
}, (port) => ["node", [path.join(HERE, "servers", "ultimate.mjs"), String(port)]]);

if (targets.length === 0) { console.error("no targets available"); process.exit(1); }

// ---------------------------------------------------------------- scenarios
const scenarios = [
  { id: "hello", label: "GET /hello (text)", path: "/hello" },
  { id: "json", label: "GET /json (JSON response)", path: "/json" },
  { id: "param", label: "GET /users/:id (param + JSON)", path: "/users/12345" },
  { id: "deep", label: "GET /r39x/:a/items/:b (route #41 of 44)", path: "/r39x/alpha/items/beta" },
  { id: "post", label: "POST /echo (parse JSON body + JSON response)", path: "/echo", method: "POST",
    body: JSON.stringify({ name: "Ada", langs: ["ts", "c"], n: 1, nested: { ok: true, list: [1, 2, 3, 4, 5] } }) },
];

// ---------------------------------------------------------------- helpers
const TICK = 100; // CLK_TCK on Linux
function cpuMs(pid) {
  const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return { user: (parseInt(f[11], 10) / TICK) * 1000, sys: (parseInt(f[12], 10) / TICK) * 1000 };
}
function rssMB(pid) {
  const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? parseInt(m[1], 10) / 1024 : 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function waitReady(port, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error("server exited early");
    try { const r = await fetch(`http://127.0.0.1:${port}/hello`); if (r.ok) return; } catch {}
    await sleep(50);
  }
  throw new Error("server not ready");
}

// time from spawn() until the server accepts TCP connections (polled every ~1 ms), median of `trials` launches
async function measureStartup(t, port, trials = 7) {
  const times = [];
  for (let i = 0; i < trials; i++) {
    const [cmd, argv] = pin(0, ...t.command(port));
    const t0 = process.hrtime.bigint();
    const child = spawn(cmd, argv, { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const attempt = () => {
        if (Date.now() > deadline) return reject(new Error("startup timeout"));
        const s = net.connect(port, "127.0.0.1");
        s.on("connect", () => { s.destroy(); resolve(); });
        s.on("error", () => setTimeout(attempt, 1));
      };
      attempt();
    });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    child.kill("SIGKILL");
    await sleep(150);
  }
  return median(times);
}

function load(port, sc, amount) {
  const acArgs = ["-c", String(CONNECTIONS), "-a", String(amount), "-j", "--renderStatusCodes"];
  if (sc.method) acArgs.push("-m", sc.method, "-H", "content-type=application/json", "-b", sc.body);
  acArgs.push(`http://127.0.0.1:${port}${sc.path}`);
  const [cmd, argv] = pin(1, process.execPath, [path.join(HERE, "node_modules", "autocannon", "autocannon.js"), ...acArgs]);
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("autocannon failed: " + r.stderr);
  const j = JSON.parse(r.stdout);
  return { rps: j.requests.total / j.duration, p99: j.latency.p99, errors: j.errors + j.timeouts, non2xx: j.non2xx, statuses: j["statusCodeStats"] };
}

// ---------------------------------------------------------------- run
console.log(`targets: ${targets.map((t) => t.label).join(", ")}`);
console.log(`${scenarios.length} scenarios x ${ROUNDS} rounds x ${REQUESTS} requests, ${CONNECTIONS} connections, ` +
  (haveCores ? "server pinned to core 0, load generator to core 1" : "no CPU pinning (taskset/2 cores unavailable)"));

const results = {};
let port = 5100;
for (const t of targets) {
  results[t.id] = { label: t.label, scenarios: {} };
  const p = port++;
  try { results[t.id].startupMs = await measureStartup(t, p); } catch (e) { results[t.id].startupMs = null; }
  console.log(`  ${t.label.padEnd(26)} startup ${results[t.id].startupMs?.toFixed(1)} ms`);
  if (startupOnly) continue;
  const [cmd, argv] = pin(0, ...t.command(p));
  const child = spawn(cmd, argv, { stdio: "ignore" });
  try {
    await waitReady(p, child);
    // the pinned wrapper is `taskset`, which exec()s the server: child.pid is the server's pid
    const pid = child.pid;
    await sleep(300);
    for (const sc of scenarios) {
      load(p, sc, Math.min(20000, REQUESTS)); // warm-up (JIT, caches)
      const rounds = [];
      for (let r = 0; r < ROUNDS; r++) {
        const before = cpuMs(pid);
        const l = load(p, sc, REQUESTS);
        const after = cpuMs(pid);
        const cpu = after.user + after.sys - before.user - before.sys;
        rounds.push({ ...l, cpuUsPerReq: (cpu * 1000) / REQUESTS });
      }
      const bad = rounds.find((r) => r.errors > 0 || r.non2xx > 0);
      results[t.id].scenarios[sc.id] = {
        cpuUsPerReq: median(rounds.map((r) => r.cpuUsPerReq)),
        rps: median(rounds.map((r) => r.rps)),
        p99: median(rounds.map((r) => r.p99)),
        invalid: bad ? `errors=${bad.errors} non2xx=${bad.non2xx}` : null,
      };
      console.log(`  ${t.label.padEnd(26)} ${sc.id.padEnd(6)} ${results[t.id].scenarios[sc.id].cpuUsPerReq.toFixed(1).padStart(7)} µs CPU/req  ` +
        `${Math.round(results[t.id].scenarios[sc.id].rps).toString().padStart(6)} req/s` + (bad ? "  INVALID " + results[t.id].scenarios[sc.id].invalid : ""));
    }
    results[t.id].rssMB = rssMB(pid);
  } catch (e) {
    console.log(`  ${t.label}: FAILED ${e.message}`);
    results[t.id].error = e.message;
  } finally {
    child.kill("SIGKILL");
    await sleep(300);
  }
}

// ---------------------------------------------------------------- report
if (startupOnly) process.exit(0);
const base = results["express"] ? "express" : targets[0].id;
console.log(`\nServer CPU per request (µs, lower is better) and speedup vs ${results[base].label}:`);
const head = ["scenario", ...targets.map((t) => t.label)];
console.log(head.join(" | "));
for (const sc of scenarios) {
  const row = [sc.id];
  for (const t of targets) {
    const r = results[t.id].scenarios[sc.id];
    const b = results[base].scenarios[sc.id];
    row.push(r ? `${r.cpuUsPerReq.toFixed(1)} (${(b.cpuUsPerReq / r.cpuUsPerReq).toFixed(1)}x)` : "n/a");
  }
  console.log(row.join(" | "));
}
console.log("\nRSS after run (MB): " + targets.map((t) => `${t.label}=${(results[t.id].rssMB ?? 0).toFixed(0)}`).join(", "));
console.log("Startup to first response (ms): " + targets.map((t) => `${t.label}=${results[t.id].startupMs?.toFixed(1) ?? "n/a"}`).join(", "));

fs.writeFileSync(outFile, JSON.stringify({
  generated: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, os: `${os.type()} ${os.release()}` },
  config: { requests: REQUESTS, connections: CONNECTIONS, rounds: ROUNDS, pinned: haveCores },
  scenarios, results,
}, null, 2));
console.log("\nresults written to " + outFile);
