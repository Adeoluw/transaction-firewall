import { describe, expect, it } from "vitest";
import { evaluatePolicy, getPolicy } from "../src/firewall/policy.js";
import { screenCounterparty } from "../src/firewall/screen.js";
import type { Effect } from "../src/types.js";
import addresses from "../config/addresses.json" with { type: "json" };

const { attacker, router, usdc } = addresses;
const policy = getPolicy("treasury-default");

const approval = (counterparty: string, unlimited: boolean): Effect => ({
  kind: "approval",
  description: "test",
  token: usdc,
  counterparty,
  amount: unlimited ? (2n ** 256n - 1n).toString() : "100000000",
  unlimited,
});

describe("evaluatePolicy", () => {
  it("flags unlimited approvals and non-allowlisted counterparties", () => {
    const violations = evaluatePolicy([approval(attacker, true)], [], policy);
    expect(violations).toContain("no_unlimited_approvals");
    expect(violations).toContain("counterparty_not_allowlisted");
  });

  it("passes a bounded approval to an allowlisted router", () => {
    expect(evaluatePolicy([approval(router, false)], [], policy)).toEqual([]);
  });

  it("flags transfers above the per-tx value cap", () => {
    const transfer: Effect = {
      kind: "transfer",
      description: "test",
      counterparty: router,
      amount: "900000000", // 900 USDC > 500 cap
    };
    expect(evaluatePolicy([transfer], [], policy)).toContain("max_value_per_tx_exceeded");
  });

  it("flags transfers above the treasury % cap", () => {
    const transfer: Effect = {
      kind: "transfer",
      description: "test",
      counterparty: router,
      amount: "2000000000", // 2,000 USDC = 20% of 10,000 treasury (cap 10%)
    };
    expect(evaluatePolicy([transfer], [], policy)).toContain("treasury_pct_cap_exceeded");
  });

  it("flags threatlisted counterparties from screening", async () => {
    const screens = [await screenCounterparty(attacker)];
    expect(evaluatePolicy([approval(router, false)], screens, policy)).toContain(
      "counterparty_on_threatlist",
    );
  });
});

describe("screenCounterparty", () => {
  it("flags the attacker as threatlisted and fresh", async () => {
    const screen = await screenCounterparty(attacker);
    expect(screen.flags).toContain("threatlist");
    expect(screen.flags).toContain("fresh_address");
  });

  it("leaves the aged, allowlisted router clean", async () => {
    expect((await screenCounterparty(router)).flags).toEqual([]);
  });

  it("treats unknown addresses as fresh", async () => {
    expect(
      (await screenCounterparty("0x1234000000000000000000000000000000001234")).flags,
    ).toContain("fresh_address");
  });
});
