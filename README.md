# tsos

A small AArch64 kernel written in TypeScript, compiled with
[TypeScriptCompiler](https://github.com/ASDAlexander77/TypeScriptCompiler) (`tslang`).
It boots under QEMU, sets up the MMU, GICv3 and a virtio-blk ext2 root filesystem,
and runs a Linux/musl userspace (`bash`) at EL0.

## Requirements

- `tslang` (TypeScriptCompiler) on `PATH`, or in `~/src/TypeScriptCompiler/build/bin`
- `clang` + `lld`
- `qemu-system-aarch64`
- `mke2fs` (e2fsprogs), `curl`, `tar`

## Building

1. Create your local configuration (`config.ts` is git-ignored):

   ```sh
   cp config.example.ts config.ts
   ```

2. Edit `config.ts` and pick a page size:

   ```ts
   export const page_size: bigint = 4096n; // 4096, 16384 or 65536
   ```

   | `page_size` | Granule | Notes                              |
   |-------------|---------|------------------------------------|
   | `4096n`     | 4 KB    | default                            |
   | `16384n`    | 16 KB   | e.g. Apple Silicon                 |
   | `65536n`    | 64 KB   |                                    |

3. Build and run:

   ```sh
   make        # kernel (build/boot/kernel.elf) + root filesystem (build/rootfs.img)
   make run    # boot in QEMU
   make clean
   ```

The Makefile reads `page_size` from `config.ts` to choose the QEMU CPU
(`cortex-a53` for 4 KB, `cortex-a76` otherwise, since the a53 has no 16 KB granule).
Objects are rebuilt when `config.ts` changes. Useful overrides:

```sh
make QEMU_CPU=max
make TSLANG=/path/to/tslang
make BUILD_DIR=out
```

The root filesystem is populated from a Gentoo arm64 musl stage3 tarball, downloaded
on first build (or copied from `/tmp/stage3-musl.tar.xz` if present; override with `STAGE3_URL`).
