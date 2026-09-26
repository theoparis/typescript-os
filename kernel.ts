function poke8(addr: bigint, val: u8) {
    const p = <Ref<u8>>(<Opaque>addr);
    Deref(p) = val;
}
function peek8(addr: bigint): u8 {
    const p = <Ref<u8>>(<Opaque>addr);
    return Deref(p);
}

// Memory-mapped UART peripheral address (0x09000000)
const UART_BASE = 0x09000000n;

/**
 * Sends a single character byte to the UART peripheral.
 * Expects a raw u8 byte representation instead of a JS string object.
 */
function putchar(c: u8): void {
  poke8(UART_BASE, c);
}

/**
 * Prints a null-terminated string using raw pointer indexing.
 * Emulates the C-style `while (*s)` loop.
 */
function print(s: string): void {
  // Cast straight to a byte pointer and index it - avoids `as unknown as bigint`,
  // whose unboxing path miscompiles (see below).
  const p = <Ref<u8>>(<Opaque>s);
  let offset = 0n;

  while (true) {
    // Read the character byte directly from the string's memory location
    const c = Deref(p[offset]);

    // Stop when hitting the null terminator (\0)
    if (c == 0 as u8) {
      break;
    }

    putchar(c);
    offset = offset + 1n;
  }
}

/**
 * The main kernel entry point.
 */
function kmain(): void {
  print("Hello world\n");
}
