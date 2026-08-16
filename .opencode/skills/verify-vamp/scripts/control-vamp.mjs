#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(SKILL_DIR, "../../..");
const EXAMPLE = join(REPO, "examples/basic");
const EXAMPLE_BIN = join(EXAMPLE, "node_modules/.bin");
const RUNS = join(SKILL_DIR, ".verify");
const SCENARIO_CONFIG = join(SKILL_DIR, "scenario.config.mts");
const SCENARIO_DIR = join(SKILL_DIR, "scenarios");
const READY = /Ready on (https?):\/\/([\d.]+):(\d+)/i;

const runDir = (id) => join(RUNS, id);
const artifactsDir = (id) => join(runDir(id), "artifacts");
const instancePath = (id) => join(runDir(id), "instance.json");

/**
 * Scenarios live outside any workspace package, so bare imports (`@tempojs/*`,
 * `@vampgg/*`) have nowhere to resolve from. Lend them the example app's
 * resolution root; the symlink is gitignored and costs nothing to re-create.
 */
function ensureResolution() {
  const link = join(SKILL_DIR, "node_modules");
  if (existsSync(link)) return;
  symlinkSync("../../../examples/basic/node_modules", link, "dir");
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** wrangler is spawned detached, so its whole group goes down with it. */
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function listRuns() {
  if (!existsSync(RUNS)) return [];
  return readdirSync(RUNS)
    .filter((id) => existsSync(instancePath(id)))
    .map((id) => JSON.parse(readFileSync(instancePath(id), "utf8")));
}

function resolveRunId(explicit) {
  const id = explicit ?? process.env.VAMP_RUN_ID;
  if (id) return id;
  const live = listRuns().filter((i) => alive(i.pid));
  if (live.length === 1) return live[0].runId;
  if (live.length === 0) die("no live instance; run `control-vamp up` first");
  die(`${live.length} live instances; pass --run <id> or set VAMP_RUN_ID`);
}

function readInstance(id) {
  if (!existsSync(instancePath(id))) die(`no instance recorded for run ${id}`);
  return JSON.parse(readFileSync(instancePath(id), "utf8"));
}

function tail(path, lines) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else flags[key] = argv[++i];
    } else rest.push(argv[i]);
  }
  return { flags, rest };
}

async function up(flags) {
  const runId =
    flags.run ?? process.env.VAMP_RUN_ID ?? `run-${Date.now().toString(36)}-${process.pid}`;
  const dir = runDir(runId);
  if (existsSync(instancePath(runId)) && alive(readInstance(runId).pid))
    die(`run ${runId} is already live; use \`control-vamp down --run ${runId}\` first`);
  ensureResolution();
  mkdirSync(artifactsDir(runId), { recursive: true });
  const statePath = join(dir, "wrangler-state");
  const logPath = join(dir, "wrangler.log");
  writeFileSync(logPath, "");
  const fd = openSync(logPath, "a");

  const proc = spawn(
    join(EXAMPLE_BIN, "wrangler"),
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--inspector-port",
      "0",
      "--log-level",
      "log",
      "--persist-to",
      statePath,
    ],
    {
      cwd: EXAMPLE,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    },
  );
  proc.unref();
  const pid = proc.pid;
  if (!pid) die("wrangler dev could not be spawned");

  const deadline = Date.now() + 120_000;
  for (;;) {
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const match = log.match(READY);
    if (match) {
      const instance = {
        runId,
        pid,
        port: Number(match[3]),
        url: `${match[1]}://${match[2]}:${match[3]}`,
        ws: `ws://${match[2]}:${match[3]}/v1/game`,
        startedAt: new Date().toISOString(),
        sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(),
        logPath,
        statePath,
        artifacts: artifactsDir(runId),
      };
      writeFileSync(instancePath(runId), `${JSON.stringify(instance, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(instance, null, 2)}\n`);
      process.stdout.write(`\nexport VAMP_RUN_ID=${runId}\n`);
      return;
    }
    if (/Build failed/i.test(log)) {
      killGroup(pid, "SIGKILL");
      die(`wrangler dev failed to build:\n${tail(logPath, 40)}`);
    }
    if (!alive(pid)) die(`wrangler dev exited early:\n${tail(logPath, 40)}`);
    if (Date.now() > deadline) {
      killGroup(pid, "SIGKILL");
      die(`wrangler dev did not report ready in 120s:\n${tail(logPath, 40)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function doctor(flags) {
  const runId = resolveRunId(flags.run);
  const instance = readInstance(runId);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add("process alive", alive(instance.pid), `pid ${instance.pid}`);

  let identity = "unreachable";
  let identityOk = false;
  try {
    const res = await fetch(`${instance.url}/v1/game`, { redirect: "manual" });
    const body = (await res.text()).trim();
    identity = `${res.status} ${body}`;
    identityOk = res.status === 426 && body === "Expected Upgrade: websocket";
  } catch (err) {
    identity = String(err);
  }
  add("port owned by the basic worker", identityOk, identity);

  const log = existsSync(instance.logPath) ? readFileSync(instance.logPath, "utf8") : "";
  const errors = log.split("\n").filter((line) => /\[ERROR\]|Build failed/i.test(line));
  add("wrangler log clean", errors.length === 0, errors.slice(-3).join(" | ") || "no errors");

  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  add("worker built from current HEAD", sha === instance.sha, `${instance.sha} vs ${sha}`);

  const dirty = execFileSync("git", ["status", "--porcelain", "examples/basic", "packages"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  add("sources unchanged since launch", dirty === "", dirty.split("\n").slice(0, 3).join(" | "));

  const built = ["packages/ecs", "packages/utils", "packages/worker", "packages/solid", "tools/cli"]
    .filter((p) => !existsSync(join(REPO, p, "dist")))
    .join(", ");
  add("workspace packages built", built === "", built || "all dist/ present");

  for (const c of checks) {
    process.stdout.write(`${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}\n`);
  }
  process.stdout.write(`\nrun ${runId} at ${instance.url}, artifacts in ${instance.artifacts}\n`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

function drive(flags, rest) {
  const name = rest[0];
  if (!name) die("usage: control-vamp drive <scenario> [--run <id>]");
  const scenario = isAbsolute(name)
    ? name
    : existsSync(resolve(process.cwd(), name))
      ? resolve(process.cwd(), name)
      : join(SCENARIO_DIR, name.endsWith(".mts") ? name : `${name}.scenario.mts`);
  if (!existsSync(scenario)) die(`scenario not found: ${scenario}`);

  const runId = resolveRunId(flags.run);
  const instance = readInstance(runId);
  if (!alive(instance.pid)) die(`run ${runId} is not live; run \`control-vamp up\``);
  ensureResolution();

  const label = scenario
    .split("/")
    .pop()
    .replace(/\.mts$/, "");
  const logPath = join(artifactsDir(runId), `${label}.log`);
  const chunks = [];

  const child = spawn("vp", ["test", "run", "-c", SCENARIO_CONFIG], {
    cwd: REPO,
    env: {
      ...process.env,
      VAMP_SCENARIO: scenario,
      VAMP_RUN_ID: runId,
      VAMP_PORT: String(instance.port),
      VAMP_URL: instance.url,
      VAMP_ARTIFACTS: artifactsDir(runId),
      CI: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tee = (stream, sink) =>
    stream.on("data", (chunk) => {
      chunks.push(chunk);
      sink.write(chunk);
    });
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);
  child.on("exit", (code) => {
    writeFileSync(logPath, Buffer.concat(chunks));
    process.stdout.write(`\ntranscript: ${logPath}\n`);
    process.exit(code ?? 1);
  });
}

function cli(flags, rest) {
  if (rest.length === 0) die("usage: control-vamp cli [--scratch <name>] -- <vamp args...>");
  const runId = resolveRunId(flags.run);
  const scratchName = flags.scratch ?? "cli";
  const scratch = join(runDir(runId), "scratch", scratchName);
  mkdirSync(scratch, { recursive: true });

  const child = spawn("node", [join(REPO, "tools/cli/dist/vamp.mjs"), ...rest], {
    cwd: scratch,
    env: { ...process.env, PATH: `${EXAMPLE_BIN}:${process.env.PATH}` },
    encoding: "utf8",
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (c) => {
    out.push(c);
    process.stdout.write(c);
  });
  child.stderr.on("data", (c) => {
    err.push(c);
    process.stderr.write(c);
  });
  child.on("exit", (code) => {
    const record = {
      argv: rest,
      cwd: scratch,
      exitCode: code,
      stdout: Buffer.concat(out).toString(),
      stderr: Buffer.concat(err).toString(),
      files: existsSync(scratch)
        ? readdirSync(scratch, { recursive: true }).sort((a, b) => a.localeCompare(b))
        : [],
    };
    const path = join(artifactsDir(runId), `cli-${scratchName}-${Date.now().toString(36)}.json`);
    mkdirSync(artifactsDir(runId), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(`\nexit ${code}, scratch ${scratch}, record ${path}\n`);
    process.exit(code ?? 1);
  });
}

async function down(flags) {
  const targets = flags.all ? listRuns().map((i) => i.runId) : [resolveRunId(flags.run)];
  for (const runId of targets) {
    const instance = readInstance(runId);
    for (const signal of ["SIGINT", "SIGKILL"]) {
      if (!alive(instance.pid)) break;
      killGroup(instance.pid, signal);
      await new Promise((r) => setTimeout(r, 1000));
    }
    rmSync(join(runDir(runId), "wrangler-state"), { recursive: true, force: true });
    rmSync(join(runDir(runId), "scratch"), { recursive: true, force: true });
    rmSync(instancePath(runId), { force: true });
    process.stdout.write(`down ${runId}; evidence kept in ${artifactsDir(runId)}\n`);
  }
}

function runs() {
  const all = listRuns();
  if (all.length === 0) return process.stdout.write("no recorded instances\n");
  for (const i of all) {
    process.stdout.write(`${alive(i.pid) ? "live" : "dead"}  ${i.runId}  ${i.url}  pid ${i.pid}\n`);
  }
}

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);
const commands = { up, doctor, drive, cli, down, runs };
if (!commands[command]) {
  die(`usage: control-vamp <${Object.keys(commands).join("|")}> [--run <id>] [args]`);
}
await commands[command](flags, rest);
