# ts2c

A small TypeScript → C compiler for systems-style TypeScript. It emits C, then
uses `clang` as a subprocess for code generation. There is no C++ compiler code
here and no linking against LLVM.

The initial target is the dialect used by [`typescript-os`](../typescript-os):
fixed-width integers, `bigint` addresses, `Ref<T>`, `Opaque`, `Deref`, inline
assembly, and C-like classes.

## Usage

```sh
ant install

# Emit C
ant src/cli.ts test/classes.ts -o build/classes.c --entry main

# Emit an AArch64 object
ant src/cli.ts test/classes.ts -o build/classes.o --emit obj

# Run the test suite
ant test/run.ts
```

The object command is equivalent to:

```sh
clang --target=aarch64-unknown-none-elf \
  -std=c11 -ffreestanding -fno-builtin -fno-stack-protector -fno-pic -O2 \
  -I runtime -c build/classes.c -o build/classes.o
```

### Kernel integration

`Ref<T>` compiles to `volatile T *` so MMIO polling loops are not hoisted by
the optimizer. `bigint` is signed `int64_t`, which keeps descending loops such
as `for (let i = 60n; i >= 0n; i = i - 4n)` working.

The `typescript-os` kernel has been built all the way to `kernel.elf` and
booted under QEMU with a virtio-blk device; it reaches GIC, MMU, virtio-blk,
and ext2 probing.

For the existing `typescript-os` kernel:

```sh
ant /path/to/ts2c/src/cli.ts ../typescript-os/kmain.ts -o build/kmain.c

clang --target=aarch64-unknown-none-elf -std=c11 -ffreestanding \
  -fno-builtin -fno-stack-protector -fno-pic -O2 \
  -Wno-parentheses-equality -I /path/to/ts2c/runtime \
  -c build/kmain.c -o build/kmain.o

clang --target=aarch64-unknown-none-elf -std=c11 -ffreestanding \
  -fno-builtin -fno-stack-protector -fno-pic -O2 \
  -I /path/to/ts2c/runtime -c /path/to/ts2c/runtime/ts2c_runtime.c \
  -o build/ts2c_runtime.o
```

Link `kmain.o`, `ts2c_runtime.o`, and the existing assembly objects with the
kernel linker script.

## How it works

1. Parse TypeScript with the TypeScript compiler API.
2. Build a module graph from relative imports.
3. Collect top-level functions, classes, structs, enums, and variables.
4. Resolve types and class layouts.
5. Emit one C translation unit with module-prefixed symbol names.
6. Invoke `clang` for an object file, or stop at the C output.

Classes are lowered to C structs and vtables:

```ts
class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  speak(): string { return "animal"; }
}

class Dog extends Animal {
  speak(): string { return "woof"; }
}
```

becomes a `struct Animal`/`struct Dog` with a shared prefix, a vtable per
class, `Animal___new`, and dispatch through `ts2c_vtable`. `instanceof` walks
the generated `Ts2cClass` parent chain.

Top-level functions also get an unprefixed wrapper (`kmain`, etc.) so existing
assembly can keep calling `kmain` while generated C uses collision-safe names.
Names that commonly collide with libc (`main`, `putchar`, `getchar`, `printf`,
`malloc`, ...) are not wrapped.

## Supported

- modules, named imports, namespace imports, exports, re-exports
- functions and top-level variables
- classes: fields, constructors, inheritance, virtual methods, getters/setters,
  static fields/methods, parameter properties, `instanceof`
- interfaces and object type aliases as C structs
- enums
- `let`/`const`, `if`/`else`, `while`, `do`, `for`, `switch`, `break`,
  `continue`, `return`
- casts (`as T`, `<T>x`), string concatenation and equality
- object literals when the target struct type is known
- the tsos dialect: `u8/u16/u32/u64`, `i8/i16/i32/i64`, `bigint`, `Ref<T>`,
  `Opaque`, `Deref`, `inline_asm`, `peek*`/`poke*`, `print`, `printHex64`
- `console.log` for strings, integers, and floats

## Type mapping

| TypeScript | C |
|---|---|
| `u8`/`i8` | `uint8_t`/`int8_t` |
| `u16`/`i16` | `uint16_t`/`int16_t` |
| `u32`/`i32` | `uint32_t`/`int32_t` |
| `u64`/`i64` | `uint64_t`/`int64_t` |
| `bigint` | `int64_t` (signed 64-bit; not arbitrary precision) |
| `number` | `int64_t` (not IEEE-754 `double`) |
| `string` | `char *` (NUL-terminated) |
| `Ref<T>` | `volatile T *` |
| `Opaque` | `uintptr_t` |
| `boolean` | `bool` |

## Not supported yet

- generics
- `any` / `unknown` / dynamic property access
- arrow functions and closures
- dynamic arrays and array literals
- destructuring, rest parameters
- `async` / `await`, generators
- `try` / `catch` / `finally` (exceptions currently compile to `ts2c_panic`)
- decorators, namespaces, `for...of`
- method signatures on interfaces
- union types beyond `T | null` / `T | undefined`
- full JavaScript number semantics

These produce explicit compile errors rather than silently doing the wrong
thing.

## Runtime

`runtime/ts2c_runtime.c` is freestanding by default: `ts2c_alloc` is a 1 MiB
bump allocator and logging functions are no-ops. Define `TS2C_HOSTED` to use
`malloc`, `printf`, and `putchar` for host-side tests.

`ts2c_alloc` is intentionally minimal. The next runtime step is a real
allocator/GC appropriate for the target.
