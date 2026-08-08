/**
 * Unit-тесты на multi-asset поддержку /status и /explain (новое в Q2).
 * Parity fixtures (parser-commands.json) покрывают только legacy без аргумента.
 */
import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/telegram/parser";

describe("/status SYMBOL parsing", () => {
  it("/status без аргумента → kind=status, asset_symbol=null (legacy)", () => {
    const result = parseCommand("/status");
    expect(result.kind).toBe("status");
    expect(result.asset_symbol).toBeNull();
  });

  it("/status EUR/USD → kind=status, asset_symbol='EUR/USD'", () => {
    const result = parseCommand("/status EUR/USD");
    expect(result.kind).toBe("status");
    expect(result.asset_symbol).toBe("EUR/USD");
    expect(result.asset_direction).toBeNull();
  });

  it("/status XAU/USD → uppercase, без direction", () => {
    const result = parseCommand("/status xau/usd");
    expect(result.kind).toBe("status");
    expect(result.asset_symbol).toBe("XAU/USD");
  });

  it("/status ROSN → MOEX tickers тоже валидны", () => {
    const result = parseCommand("/status ROSN");
    expect(result.kind).toBe("status");
    expect(result.asset_symbol).toBe("ROSN");
  });

  it("/status @ — некорректный symbol → kind=unknown", () => {
    const result = parseCommand("/status @badtoken");
    expect(result.kind).toBe("unknown");
  });

  it("/status@MyBot ROSN — @BotName suffix корректно зачищается", () => {
    const result = parseCommand("/status@MyBot ROSN");
    expect(result.kind).toBe("status");
    expect(result.asset_symbol).toBe("ROSN");
  });
});

describe("/explain SYMBOL parsing", () => {
  it("/explain без аргумента → kind=explain, asset_symbol=null (legacy)", () => {
    const result = parseCommand("/explain");
    expect(result.kind).toBe("explain");
    expect(result.asset_symbol).toBeNull();
  });

  it("/explain ROSN → kind=explain, asset_symbol='ROSN'", () => {
    const result = parseCommand("/explain ROSN");
    expect(result.kind).toBe("explain");
    expect(result.asset_symbol).toBe("ROSN");
  });

  it("/explain BTC/USD → forex/crypto syntax работает", () => {
    const result = parseCommand("/explain BTC/USD");
    expect(result.kind).toBe("explain");
    expect(result.asset_symbol).toBe("BTC/USD");
  });

  it("/explain $$$ — некорректный symbol → kind=unknown", () => {
    const result = parseCommand("/explain $$$");
    expect(result.kind).toBe("unknown");
  });
});
