export function add(a: number, b: number): number {
  return a + b;
}

export const scale: number = 3;

export class Counter {
  value: number;

  constructor(start: number) {
    this.value = start;
  }

  add(n: number): number {
    this.value = this.value + n;
    return this.value;
  }
}
