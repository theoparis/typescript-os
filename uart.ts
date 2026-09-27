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

function poke16(addr: bigint, val: u16): void {
    const p = <Ref<u16>>(<Opaque>addr);
    Deref(p) = val;
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
function has_char(): boolean {
    return (peek32(UART_BASE + 0x18n) & (0x10 as u32)) === (0 as u32);
}

// Incremented by the timer interrupt; used for syscall timeouts.
let timer_ticks: u64 = 0n;

export function bump_timer_ticks(): void {
    timer_ticks = timer_ticks + 1n;
}

export function now_ticks(): u64 {
    return timer_ticks;
}

function getchar(): u8 {
    while (!has_char()) {
    }
    return peek8(UART_BASE + 0x00n);
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
