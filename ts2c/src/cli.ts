#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Compiler, CompileError } from "./compiler";

interface Args {
  input?: string;
  output?: string;
  emit: "c" | "obj";
  target: string;
  entry?: string;
  clang: string;
  keepC: boolean;
  noRuntime: boolean;
}

function usage(): never {
  console.error(`usage: ts2c <input.ts> [options]

options:
  -o, --output <path>     output .c or .o path
  --emit <c|obj>          emit C (default: c) or an object file
  --target <triple>       clang target (default: aarch64-unknown-none-elf)
  --entry <function>      emit a C main() that calls this TS function
  --clang <path>          clang executable (default: clang)
  --keep-c                keep the generated .c when emitting an object
  --no-runtime            do not pass the ts2c runtime include path
  -h, --help              show this help`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    emit: "c",
    target: "aarch64-unknown-none-elf",
    clang: "clang",
    keepC: false,
    noRuntime: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        usage();
        break;
      case "-o":
      case "--output":
        a.output = argv[++i];
        break;
      case "--emit":
        a.emit = argv[++i] as "c" | "obj";
        if (a.emit !== "c" && a.emit !== "obj") usage();
        break;
      case "--target":
        a.target = argv[++i];
        break;
      case "--entry":
        a.entry = argv[++i];
        break;
      case "--clang":
        a.clang = argv[++i];
        break;
      case "--keep-c":
        a.keepC = true;
        break;
      case "--no-runtime":
        a.noRuntime = true;
        break;
      default:
        if (arg.startsWith("-")) usage();
        if (a.input) usage();
        a.input = arg;
        break;
    }
  }
  if (!a.input) usage();
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input!);
  const out = args.output ? path.resolve(args.output)
    : path.resolve(path.basename(input).replace(/\.(ts|tsx)$/i, args.emit === "obj" ? ".o" : ".c"));

  const compiler = new Compiler({ entry: input, target: args.target, entryFunction: args.entry });
  let cSource: string;
  try {
    cSource = compiler.compile();
  } catch (e) {
    if (e instanceof CompileError) {
      console.error(`ts2c: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const runtimeDir = path.resolve(import.meta.dir, "..", "runtime");

  if (args.emit === "c") {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, cSource);
    console.log(`wrote ${out}`);
    return;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cPath = args.keepC ? out.replace(/\.o$/i, ".c") : path.join(path.dirname(out), `.ts2c-${path.basename(out)}.c`);
  fs.writeFileSync(cPath, cSource);

  const clangArgs = [
    `--target=${args.target}`,
    "-std=c11",
    "-ffreestanding",
    "-fno-builtin",
    "-fno-stack-protector",
    "-fno-pic",
    "-O2",
    "-c",
    cPath,
    "-o",
    out,
  ];
  if (!args.noRuntime) clangArgs.push("-I", runtimeDir);

  const r = spawnSync(args.clang, clangArgs, { stdio: "inherit" });
  if (!args.keepC) {
    try { fs.unlinkSync(cPath); } catch {}
  }
  if (r.error) {
    console.error(`ts2c: failed to run ${args.clang}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`wrote ${out}`);
}

main();
