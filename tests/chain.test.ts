// Integration tests against a REAL local Anvil chain: deploys the demo
// contracts, executes transactions on fork snapshots, and verifies the
// co-signer gate. Skipped automatically when Anvil is not installed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.ANVIL_PORT = "8599"; // do not collide with a running dev server
process.env.SEPOLIA_RPC_URL = "http://127.0.0.1:1"; // force no-fork local chain in tests

const anvilPresent = existsSync(join(process.cwd(), "tools", "foundry", "anvil.exe"));

describe.skipIf(!anvilPresent)("real chain integration", () => {
  let chainMod: typeof import("../src/chain/anvil.js");
  let registryMod: typeof import("../src/chain/registry.js");
  let simulateMod: typeof import("../src/firewall/simulate.js");
  let cosignerMod: typeof import("../src/cosigner/index.js");
  let seedgenMod: typeof import("../src/seedgen.js");

  beforeAll(async () => {
    chainMod = await import("../src/chain/anvil.js");
    registryMod = await import("../src/chain/registry.js");
    simulateMod = await import("../src/firewall/simulate.js");
    cosignerMod = await import("../src/cosigner/index.js");
    seedgenMod = await import("../src/seedgen.js");
    const chain = await chainMod.startChain(cosignerMod.cosignerAddress());
    expect(chain).not.toBeNull();
  }, 60000);

  afterAll(() => chainMod?.stopChain());

  it("boots with the treasury funded", async () => {
    const bal = await chainMod.usdcBalance(registryMod.registry.treasury);
    expect(bal).toBe(10_000_000_000n); // 10,000 USDC (6 decimals)
  });

  it("AnvilSimulator observes the REAL unlimited approval on a fork snapshot", async () => {
    const samples = seedgenMod.buildSamples(registryMod.registry);
    const hero = samples.find((s) => s.id === "hidden-approval")!;
    const sim = new simulateMod.AnvilSimulator();
    const result = await sim.simulate({ ...hero.tx, claimed: hero.claimed });
    expect(result.backend).toBe("anvil");
    expect(result.simulated).toBe(true);
    const approval = result.effects.find((e) => e.kind === "approval");
    expect(approval?.unlimited).toBe(true);
    expect(approval?.counterparty).toBe(registryMod.registry.attacker);
    // Snapshot reverted: no allowance persists after simulation.
    const allowance = await chainMod.usdcAllowance(
      registryMod.registry.treasury,
      registryMod.registry.attacker,
    );
    expect(allowance).toBe(0n);
  }, 30000);

  it("co-signer refuses the hero payload, signs and executes a safe transfer", async () => {
    const sim = new simulateMod.AnvilSimulator();
    const samples = seedgenMod.buildSamples(registryMod.registry);

    const hero = samples.find((s) => s.id === "hidden-approval")!;
    const refused = await cosignerMod.signIfSafe(
      { ...hero.tx, claimed: hero.claimed },
      "treasury-default",
      sim,
      true,
    );
    expect(refused.signed).toBe(false);
    expect(refused.verdict.verdict).toBe("malicious");
    expect(refused.rawTransaction).toBeUndefined();

    const safe = samples.find((s) => s.id === "safe-approve")!;
    const signed = await cosignerMod.signIfSafe(
      { ...safe.tx, claimed: safe.claimed },
      "treasury-default",
      sim,
      true,
    );
    expect(signed.signed).toBe(true);
    expect(signed.txHash).toBeDefined();
    const allowance = await chainMod.usdcAllowance(
      registryMod.registry.treasury,
      registryMod.registry.router,
    );
    expect(allowance).toBe(100_000_000n); // the bounded approve really executed
  }, 30000);

  it("catches the LYING CONTRACT: clean swap calldata that drains on execution", async () => {
    await chainMod.resetChain();
    const sim = new simulateMod.AnvilSimulator();
    const samples = seedgenMod.buildSamples(registryMod.registry);
    const lie = samples.find((s) => s.id === "lying-contract")!;

    // Decoder is fooled: static decode sees an innocent swap, no drain.
    const decoded = new simulateMod.DecodeSimulator();
    const decodeResult = await decoded.simulate({ ...lie.tx, claimed: lie.claimed });
    expect(decodeResult.effects.every((e) => e.kind !== "transfer")).toBe(true);

    // Simulation catches it: real execution shows USDC leaving to the attacker.
    const result = await sim.simulate({ ...lie.tx, claimed: lie.claimed });
    expect(result.backend).toBe("anvil");
    expect(BigInt(result.treasuryDelta!.usdc)).toBeLessThan(0n);
    expect(result.treasuryDelta!.recipients).toContain(registryMod.registry.attacker);
    const drainTransfer = result.effects.find((e) => e.kind === "transfer");
    expect(drainTransfer?.counterparty).toBe(registryMod.registry.attacker);

    // Co-signer refuses despite the router being allowlisted.
    const signed = await cosignerMod.signIfSafe({ ...lie.tx, claimed: lie.claimed }, "treasury-default", sim, true);
    expect(signed.signed).toBe(false);
    expect(signed.verdict.verdict).toBe("malicious");
    expect(signed.verdict.policyViolations).toContain("treasury_drain");
  }, 30000);

  it("catches selector variants: increaseAllowance and setApprovalForAll", async () => {
    await chainMod.resetChain();
    const sim = new simulateMod.AnvilSimulator();
    const samples = seedgenMod.buildSamples(registryMod.registry);

    const inc = samples.find((s) => s.id === "increase-allowance")!;
    const incResult = await cosignerMod.signIfSafe({ ...inc.tx, claimed: inc.claimed }, "treasury-default", sim, true);
    expect(incResult.signed).toBe(false);
    expect(incResult.verdict.verdict).toBe("malicious");

    const nft = samples.find((s) => s.id === "approve-all-nft")!;
    const nftResult = await cosignerMod.signIfSafe({ ...nft.tx, claimed: nft.claimed }, "treasury-default", sim, true);
    expect(nftResult.signed).toBe(false);
    const approvalAll = nftResult.verdict.effects.find((e) => e.kind === "approval_all");
    expect(approvalAll?.counterparty).toBe(registryMod.registry.attacker);
  }, 30000);

  it("catches the BATCH RIDER: benign rebalance with a hidden drain", async () => {
    await chainMod.resetChain();
    const sim = new simulateMod.AnvilSimulator();
    const samples = seedgenMod.buildSamples(registryMod.registry);
    const batch = samples.find((s) => s.id === "batch-rider")!;

    const result = await sim.simulate({ ...batch.tx, claimed: batch.claimed });
    // Two transfers observed: the alibi (to router) AND the rider (to attacker).
    const recipients = result.effects.filter((e) => e.kind === "transfer").map((e) => e.counterparty);
    expect(recipients).toContain(registryMod.registry.attacker);
    expect(BigInt(result.treasuryDelta!.usdc)).toBeLessThan(0n);

    const signed = await cosignerMod.signIfSafe({ ...batch.tx, claimed: batch.claimed }, "treasury-default", sim, true);
    expect(signed.signed).toBe(false);
    expect(signed.verdict.verdict).toBe("malicious");
  }, 30000);

  it("unchecked execution really drains the treasury (Run 1 path)", async () => {
    await chainMod.resetChain();
    const samples = seedgenMod.buildSamples(registryMod.registry);
    const hero = samples.find((s) => s.id === "hidden-approval")!;
    await chainMod.executeAs(hero.tx.from, hero.tx.to, hero.tx.data as `0x${string}`, 0n);

    // Attacker exploits the granted allowance.
    const { encodeFunctionData, parseAbi } = await import("viem");
    const drain = encodeFunctionData({
      abi: parseAbi(["function transferFrom(address from, address to, uint256 amount)"]),
      functionName: "transferFrom",
      args: [
        registryMod.registry.treasury as `0x${string}`,
        registryMod.registry.attacker as `0x${string}`,
        10_000_000_000n,
      ],
    });
    await chainMod.executeAs(registryMod.registry.attacker, registryMod.registry.usdc, drain, 0n);

    expect(await chainMod.usdcBalance(registryMod.registry.treasury)).toBe(0n);
    expect(await chainMod.usdcBalance(registryMod.registry.attacker)).toBe(10_000_000_000n);
    await chainMod.resetChain();
  }, 30000);
});
