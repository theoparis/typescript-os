// UART and Hardware Memory / Arithmetic Primitives

const UART_BASE = 0x09000000n;

function poke8(addr: bigint, val: u8): void {
    const p = <Ref<u8>>(<Opaque>addr);
    Deref(p) = val;
}

function peek8(addr: bigint): u8 {
    const p = <Ref<u8>>(<Opaque>addr);
    return Deref(p);
}

function peek16(addr: bigint): u32 {
    const p = <Ref<u16>>(<Opaque>addr);
    return Deref(p) as u32;
}

function poke32(addr: bigint, val: u32): void {
    const p = <Ref<u32>>(<Opaque>addr);
    Deref(p) = val;
}

function peek32(addr: bigint): u32 {
    const p = <Ref<u32>>(<Opaque>addr);
    return Deref(p);
}

function poke64(addr: bigint, val: u64): void {
    const p = <Ref<u64>>(<Opaque>addr);
    Deref(p) = val;
}

function peek64(addr: bigint): u64 {
    const p = <Ref<u64>>(<Opaque>addr);
    return Deref(p);
}

// 64-bit hardware shifts & division via inline asm
function lshr64(v: u64, shift: u64): u64 {
    return inline_asm<u64>("lsr $0, $1, $2", "=r,r,r", v, shift);
}

function shl64(v: u64, shift: u64): u64 {
    return inline_asm<u64>("lsl $0, $1, $2", "=r,r,r", v, shift);
}

function udiv64(n: u64, d: u64): u64 {
    return inline_asm<u64>("udiv $0, $1, $2", "=r,r,r", n, d);
}

function putchar(c: u8): void {
    poke8(UART_BASE, c);
}

function print(s: string): void {
    const p = <Ref<u8>>(<Opaque>s);
    let offset = 0n;
    while (true) {
        const c = Deref(p[offset]);
        if (c == 0 as u8) {
            break;
        }
        putchar(c);
        offset = offset + 1n;
    }
}

function printHex64(v: u64): void {
    for (let i = 60n; i >= 0n; i = i - 4n) {
        const d = lshr64(v, i) & 0xfn;
        if (d < 10n) {
            putchar((48n + d) as u8);
        } else {
            putchar((65n + d - 10n) as u8);
        }
    }
}
