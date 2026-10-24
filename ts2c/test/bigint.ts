function main(): void {
  let text = "";
  for (let i = 3n; i >= 0n; i = i - 1n) {
    text = text + "x";
  }
  console.log(text);

  const negative: bigint = -2n;
  console.log(negative);

  const addresses: u64 = 0x0000fffffffff000n as u64;
  console.log(addresses);
}

export { main };
