#!/bin/sh
set -e

mkdir -p build/{bin,boot,lib}

export PATH=$HOME/src/TypeScriptCompiler/build/bin:$PATH
 
tslang --mtriple=aarch64-unknown-none-elf --mm=rc --emit=obj -o build/kernel.o kernel.ts
clang -fuse-ld=lld -nostdlib -Tlinker.ld --target=aarch64-unknown-none-elf boot.s build/kernel.o -o build/boot/kernel.elf
