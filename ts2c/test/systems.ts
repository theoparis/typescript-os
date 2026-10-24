function lsr(v: u64, n: u64): u64 {
  return inline_asm<u64>("lsr $0, $1, $2", "=r,r,r", v, n);
}

function peek8(addr: bigint): u8 {
  const p = <Ref<u8>>(<Opaque>addr);
  return Deref(p);
}

function poke8(addr: bigint, value: u8): void {
  const p = <Ref<u8>>(<Opaque>addr);
  Deref(p) = value;
}

function peekAt(addr: bigint, index: u64): u8 {
  const p = <Ref<u8>>(<Opaque>addr);
  return Deref(p[index]);
}

function pokeAt(addr: bigint, index: u64, value: u8): void {
  const p = <Ref<u8>>(<Opaque>addr);
  Deref(p[index]) = value;
}

export { lsr, peek8, poke8, peekAt, pokeAt };
