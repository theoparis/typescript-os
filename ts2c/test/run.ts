#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "build", "test");
const cli = path.join(root, "src", "cli.ts");
const cc = process.env.HOST_CC ?? (process.platform === "darwin" ? "/usr/bin/clang" : "cc");
const crossClang = process.env.CLANG ?? "clang";

function run(cmd: string, args: string[], cwd = root): { status: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function check(ok: boolean, msg: string): void {
  if (!ok) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}

function compileTs(input: string, output: string, entry?: string): void {
  const args = ["run", cli, input, "-o", output];
  if (entry) args.push("--entry", entry);
  const r = run("bun", args);
  check(r.status === 0, `ts2c ${path.basename(input)} -> ${path.basename(output)}`);
}

function compileHost(input: string, output: string, entry?: string): void {
  compileTs(input, output + ".c", entry);
  const r = run(cc, [
    "-std=c11", "-DTS2C_HOSTED", "-I", path.join(root, "runtime"),
    output + ".c", path.join(root, "runtime", "ts2c_runtime.c"), "-o", output,
  ]);
  check(r.status === 0, `host compile ${path.basename(output)}`);
}

function compileCross(input: string, output: string): void {
  compileTs(input, output + ".c");
  const r = run(crossClang, [
    "--target=aarch64-unknown-none-elf",
    "-std=c11", "-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-fno-pic",
    "-Wno-parentheses-equality",
    "-I", path.join(root, "runtime"),
    "-c", output + ".c", "-o", output,
  ]);
  check(r.status === 0, `aarch64 object ${path.basename(output)}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

compileHost(path.join(root, "test", "classes.ts"), path.join(out, "classes"), "main");
const classes = run(path.join(out, "classes"), []);
check(classes.status === 0, "classes exits 0");
check(classes.out === "woof\nrex\n1\n3\n5\ngeneric\n", "classes output");

compileHost(path.join(root, "test", "imports.ts"), path.join(out, "imports"), "main");
const imports = run(path.join(out, "imports"), []);
check(imports.status === 0, "imports exits 0");
check(imports.out === "15\n15\n", "imports output");

compileHost(path.join(root, "test", "bigint.ts"), path.join(out, "bigint"), "main");
const bigint = run(path.join(out, "bigint"), []);
check(bigint.status === 0, "bigint exits 0");
check(bigint.out === "xxxx\n-2\n281474976706560\n", "bigint output");
compileCross(path.join(root, "test", "classes.ts"), path.join(out, "classes.o"));
compileCross(path.join(root, "test", "systems.ts"), path.join(out, "systems.o"));

console.log("\nall tests passed");
