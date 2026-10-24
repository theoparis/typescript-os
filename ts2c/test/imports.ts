import { add, scale, Counter } from "./lib";

function main(): void {
  const total: number = add(2, 3) * scale;
  console.log(total);

  const c: Counter = new Counter(10);
  console.log(c.add(5));
}

export { main };
