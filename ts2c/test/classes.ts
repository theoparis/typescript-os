enum Kind {
  A,
  B = 5,
  C,
}

interface Point {
  x: number;
  y: number;
}

class Animal {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  speak(): string {
    return "animal";
  }

  get label(): string {
    return this.name;
  }

  static make(name: string): Animal {
    return new Animal(name);
  }
}

class Dog extends Animal {
  age: number;

  constructor(name: string, age: number) {
    super(name);
    this.age = age;
  }

  speak(): string {
    return "woof";
  }
}

function main(): void {
  const animal: Animal = new Dog("rex", 3);
  console.log(animal.speak());
  console.log(animal.label);
  console.log(animal instanceof Dog);

  const point: Point = { x: 1, y: 2 };
  console.log(point.x + point.y);

  const kind: Kind = Kind.B;
  console.log(kind);

  const made: Animal = Animal.make("generic");
  console.log(made.name);
}

export { main };
