/**
 * Parity test: TS parser vs Python golden output.
 * Fixtures сгенерированы tools/scripts/gen_parity_fixtures.py.
 *
 * Если TS-результат расходится с Python — fail. Этот тест — единственная
 * причина существования fixtures: гарантирует identity behavior после порта.
 */
import { describe, expect, it } from "vitest";
import { parseCallback, parseCommand } from "../../src/telegram/parser";
import callbackFixtures from "./fixtures/parser-callbacks.json" with { type: "json" };
import commandFixtures from "./fixtures/parser-commands.json" with { type: "json" };

/**
 * Python timedelta сериализуется в `{__type__: "timedelta", total_seconds: N}`.
 * TS использует duration как простое число seconds. Конвертируем expected
 * для сравнения.
 */
function normalizeExpected(expected: unknown): unknown {
  if (expected && typeof expected === "object") {
    const obj = expected as Record<string, unknown>;
    if (obj.__type__ === "timedelta" && typeof obj.total_seconds === "number") {
      return obj.total_seconds;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = normalizeExpected(v);
    }
    return result;
  }
  return expected;
}

/**
 * TS-extension: Python parser не знал про новые fields (asset_symbol,
 * asset_direction для /subscribe, /unsubscribe). Заполняем их в expected
 * фиктурах как null чтобы strict toEqual проходил для legacy commands.
 */
function addNewFieldsToExpected(expected: unknown): unknown {
  if (expected && typeof expected === "object") {
    const obj = expected as Record<string, unknown>;
    if ("kind" in obj && typeof obj.kind === "string") {
      // Only for ParsedCommand — has kind + duration + etc.
      if (!("asset_symbol" in obj)) obj.asset_symbol = null;
      if (!("asset_direction" in obj)) obj.asset_direction = null;
    }
  }
  return expected;
}

describe("parseCommand parity (Python golden)", () => {
  for (const c of commandFixtures as Array<{ input: string; expected: unknown }>) {
    it(`"${c.input}" → ${(c.expected as { kind?: string })?.kind ?? "?"}`, () => {
      const actual = parseCommand(c.input);
      const expected = addNewFieldsToExpected(normalizeExpected(c.expected));
      expect(actual).toEqual(expected);
    });
  }
});

describe("parseCallback parity (Python golden)", () => {
  for (const c of callbackFixtures as Array<{ input: string; expected: unknown }>) {
    it(`"${c.input}" → ${(c.expected as { kind?: string })?.kind ?? "?"}`, () => {
      const actual = parseCallback(c.input);
      const expected = normalizeExpected(c.expected) as Record<string, unknown>;
      // Callback: add new asset_symbol/direction fields для строгого toEqual.
      if (expected && typeof expected === "object" && "kind" in expected) {
        if (!("asset_symbol" in expected)) expected.asset_symbol = null;
        if (!("asset_direction" in expected)) expected.asset_direction = null;
      }
      expect(actual).toEqual(expected);
    });
  }
});
