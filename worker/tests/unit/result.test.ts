import { describe, expect, it } from "vitest";
import { err, isErr, isOk, ok, unwrap } from "../../src/lib/result";

describe("Result", () => {
  it("ok wraps value", () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it("err wraps error", () => {
    const r = err("fail");
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) expect(r.error).toBe("fail");
  });

  it("unwrap returns value on ok", () => {
    expect(unwrap(ok("hello"))).toBe("hello");
  });

  it("unwrap throws on err with Error instance", () => {
    const e = new Error("boom");
    expect(() => unwrap(err(e))).toThrow("boom");
  });

  it("unwrap throws Error wrapping non-Error err", () => {
    expect(() => unwrap(err("nope"))).toThrow("nope");
  });

  it("type narrowing works correctly", () => {
    const r: ReturnType<typeof ok<number>> | ReturnType<typeof err<string>> = ok(1);
    if (isOk(r)) {
      const v: number = r.value;
      expect(v).toBe(1);
    }
  });
});
