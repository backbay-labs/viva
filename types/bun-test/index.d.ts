declare module "bun:test" {
  type TestBody = () => void | Promise<void>;

  type TestFn = {
    (name: string, fn: TestBody): void;
    skip: (name: string, fn?: TestBody) => void;
    only: (name: string, fn: TestBody) => void;
  };

  export type Matchers<T = unknown> = {
    not: Matchers<T>;
    toBe: (expected: unknown) => void;
    toBeCloseTo: (expected: number, precision?: number) => void;
    toBeGreaterThan: (expected: number) => void;
    toBeGreaterThanOrEqual: (expected: number) => void;
    toBeLessThan: (expected: number) => void;
    toBeLessThanOrEqual: (expected: number) => void;
    toBeUndefined: () => void;
    toContain: (expected: unknown) => void;
    toEqual: (expected: unknown) => void;
    toHaveLength: (expected: number) => void;
    toMatchObject: (expected: object) => void;
    toThrow: (expected?: string | RegExp | Error) => void;
  };

  export const describe: TestFn;
  export const test: TestFn;
  export const it: TestFn;
  export function expect<T = unknown>(actual: T): Matchers<T>;
}
