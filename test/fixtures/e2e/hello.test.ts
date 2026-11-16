import { describe, test, expect } from "bun:test";
import { hello } from "./hello";

describe("hello", () => {
  test("returns hello", () => {
    expect(hello()).toBe("hello");
  });
});
