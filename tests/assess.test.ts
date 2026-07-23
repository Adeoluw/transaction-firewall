// End-to-end pipeline tests using the committed seed payloads — verifies the
// exact bytes used on stage produce the expected verdicts.
import { describe, expect, it } from "vitest";
import { assess } from "../src/firewall/assess.js";
import { DecodeSimulator } from "../src/firewall/simulate.js";
import seed from "../seed/payloads.json" with { type: "json" };

const simulator = new DecodeSimulator();

describe("assess (seeded demo payloads)", () => {
  for (const sample of seed.samples) {
    // simOnly samples are execution-hidden attacks: only real fork simulation
    // catches them. In this offline (decode) test they resolve to their
    // documented offlineExpected outcome instead.
    const expected = (sample as { simOnly?: boolean }).simOnly
      ? (sample as { offlineExpected: string }).offlineExpected
      : sample.expected;
    it(`${sample.id} → ${expected} (offline)`, async () => {
      const verdict = await assess(
        { ...sample.tx, claimed: sample.claimed },
        "treasury-default",
        simulator,
      );
      expect(verdict.verdict).toBe(expected);
    });
  }

  it("offline decode is fooled by the lying contract — proving simulation is necessary", async () => {
    const lie = seed.samples.find((s) => s.id === "lying-contract")!;
    const verdict = await assess({ ...lie.tx, claimed: lie.claimed }, "treasury-default", simulator);
    // Decode-only sees a harmless swap and does NOT block it. The chain
    // integration test proves simulation catches the same bytes.
    expect(verdict.verdict).toBe("safe");
  });

  it("hero payload verdict names the lie and the real effect", async () => {
    const hero = seed.samples.find((s) => s.id === "hidden-approval")!;
    const verdict = await assess(
      { ...hero.tx, claimed: hero.claimed },
      "treasury-default",
      simulator,
    );
    expect(verdict.verdict).toBe("malicious");
    expect(verdict.reason).toContain("Swap 100 USDC");
    expect(verdict.realEffect).toContain("UNLIMITED");
    expect(verdict.counterparty?.flags).toEqual(
      expect.arrayContaining(["threatlist", "fresh_address"]),
    );
    expect(verdict.policyViolations).toEqual(
      expect.arrayContaining(["no_unlimited_approvals", "counterparty_not_allowlisted"]),
    );
  });

  it("fails closed on an unresolved/reverting transaction (never signs it)", async () => {
    // An unrecognized selector decodes to an 'unknown' effect — must block.
    const verdict = await assess(
      {
        from: seed.addresses.treasury,
        to: seed.addresses.usdc,
        value: "0",
        chainId: 31337,
        data: "0xdeadbeef",
      },
      "treasury-default",
      simulator,
    );
    expect(verdict.blocked).toBe(true);
    expect(verdict.verdict).not.toBe("safe");
    expect(verdict.policyViolations).toContain("unverifiable_effect");
  });

  it("reacts to live edits: same tx but spender swapped to the router passes", async () => {
    // The "prove it's not hardcoded" moment — approve(router, 100) is safe.
    const verdict = await assess(
      {
        from: seed.addresses.treasury,
        to: seed.addresses.usdc,
        value: "0",
        chainId: 31337,
        data: "0x095ea7b300000000000000000000000077700000000000000000000000000000000007770000000000000000000000000000000000000000000000000000000005f5e100",
      },
      "treasury-default",
      simulator,
    );
    expect(verdict.verdict).toBe("safe");
    expect(verdict.blocked).toBe(false);
  });
});
