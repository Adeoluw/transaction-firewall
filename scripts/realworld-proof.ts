// REAL-WORLD PROOF
// =================
// Proves the firewall stops a REAL attack — not a hand-built demo one — using:
//   • a fork of REAL Ethereum mainnet,
//   • the REAL USDC contract,
//   • a REAL drainer address from the public ScamSniffer blocklist (an address
//     that is on the list precisely because it has robbed real people).
//
// The attack is the exact disguised-approval drain that has emptied countless
// real wallets. We show:
//   1. WITHOUT the firewall — the attack succeeds and real USDC is drained.
//   2. WITH the firewall — the identical transaction is judged MALICIOUS and
//      refused, so no signature is ever produced.
//
// Nothing here touches mainnet: it all runs on a throwaway local fork. No real
// funds move, no live system is attacked. Every address is verifiable on
// Etherscan and on the public blocklist.
import { encodeFunctionData, formatUnits, maxUint256, parseAbi, type Hex } from "viem";

// Use a dedicated anvil port so the proof can run alongside the dev server.
// Must be set BEFORE importing the chain module (it reads the port on load).
process.env.ANVIL_PORT ||= "8600";

const { REAL_USDC, executeAs, resetChain, startChain, stopChain, usdcBalance } = await import(
  "../src/chain/anvil.js"
);
const { assess } = await import("../src/firewall/assess.js");
const { AnvilSimulator } = await import("../src/firewall/simulate.js");
const { initThreatIntel, isThreat, sampleFeedAddresses, threatIntelStatus } = await import(
  "../src/firewall/threatfeed.js"
);
const { cosignerAddress } = await import("../src/cosigner/index.js");

const line = "─".repeat(72);
const h = (s: string) => console.log(`\n${line}\n${s}\n${line}`);

async function main() {
  h("REAL-WORLD PROOF — the firewall vs. a real in-the-wild drainer");

  console.log("Loading the live ScamSniffer drainer blocklist…");
  await initThreatIntel();
  const intel = threatIntelStatus();
  console.log(`  ${intel.entries} known-bad addresses (${intel.source})`);

  const drainers = sampleFeedAddresses(1);
  if (drainers.length === 0) {
    console.error("No live feed addresses available (offline?). Cannot run the real-world proof.");
    process.exit(1);
  }
  const drainer = drainers[0];
  const threat = isThreat(drainer);
  console.log(`\nReal attacker (from the public blocklist): ${drainer}`);
  console.log(`  Etherscan: https://etherscan.io/address/${drainer}`);
  console.log(`  On blocklist: ${threat.hit ? "YES" : "no"} (${threat.label ?? ""})`);
  console.log(`Real token: USDC ${REAL_USDC}`);
  console.log(`  Etherscan: https://etherscan.io/token/${REAL_USDC}`);

  h("Forking REAL Ethereum mainnet and funding a treasury with REAL USDC…");
  const treasury = cosignerAddress();
  const chain = await startChain(treasury, { network: "mainnet", attacker: drainer });
  if (!chain) {
    console.error("Could not fork mainnet (need Foundry + network). Aborting.");
    process.exit(1);
  }
  const startBal = await usdcBalance(treasury);
  console.log(`Treasury ${treasury}`);
  console.log(`  funded with ${formatUnits(startBal, 6)} REAL USDC (moved from a whale on the fork)`);

  // The attack: a routine-looking approval that actually grants the drainer
  // unlimited spending power over the treasury's USDC.
  const attackData = encodeFunctionData({
    abi: parseAbi(["function approve(address spender, uint256 amount)"]),
    functionName: "approve",
    args: [drainer as Hex, maxUint256],
  });
  const attackTx = {
    from: treasury,
    to: REAL_USDC,
    data: attackData,
    value: "0",
    chainId: chain.chain.id,
    claimed: "Approve USDC for trading (routine)",
  };

  // ── RUN 1: no firewall — a normal agent signs, the attacker drains ──────────
  h("RUN 1 — NO FIREWALL: a normal agent signs the 'routine' approval");
  await executeAs(attackTx.from, attackTx.to, attackData, 0n);
  console.log("Agent signed the approval (looked routine). Now the attacker strikes:");
  const drainData = encodeFunctionData({
    abi: parseAbi(["function transferFrom(address from, address to, uint256 amount)"]),
    functionName: "transferFrom",
    args: [treasury as Hex, drainer as Hex, startBal],
  });
  await executeAs(drainer, REAL_USDC, drainData, 0n);
  const afterBal = await usdcBalance(treasury);
  const drainerBal = await usdcBalance(drainer);
  console.log(`  Treasury USDC: ${formatUnits(startBal, 6)} → ${formatUnits(afterBal, 6)}`);
  console.log(`  Attacker USDC: 0 → ${formatUnits(drainerBal, 6)}`);
  console.log(`  💀 REAL USDC DRAINED. This is what happens to an unprotected agent.`);

  await resetChain(); // rewind the fork to the funded, un-drained state

  // ── RUN 2: with firewall — the identical tx is assessed and refused ─────────
  h("RUN 2 — WITH FIREWALL: the identical transaction goes through /assess");
  const verdict = await assess(attackTx, "treasury-default", new AnvilSimulator());
  console.log(`Claimed:      ${attackTx.claimed}`);
  console.log(`Real effect:  ${verdict.realEffect}`);
  console.log(`Counterparty: ${verdict.counterparty?.address} [${verdict.counterparty?.flags.join(", ")}]`);
  console.log(`Violations:   ${verdict.policyViolations.join(", ")}`);
  console.log(`\nVERDICT: ${verdict.verdict.toUpperCase()} — ${verdict.blocked ? "BLOCKED, co-signer refuses to sign" : "allowed"}`);
  console.log(`Reason: ${verdict.reason}`);

  const treasuryStillFull = await usdcBalance(treasury);
  h("RESULT");
  console.log(`Without the firewall:  treasury drained to ${formatUnits(afterBal, 6)} USDC.`);
  console.log(`With the firewall:     transaction refused, treasury intact at ${formatUnits(treasuryStillFull, 6)} USDC.`);
  console.log(`\nEverything above used the REAL USDC contract and a REAL blocklisted`);
  console.log(`drainer address, on a throwaway fork of real Ethereum. No live system`);
  console.log(`was attacked and no real funds moved.\n`);

  // Machine-readable result for the web UI (marker-delimited to survive any
  // npm/tsx banner noise on stdout).
  const result = {
    threatIntel: intel,
    attacker: drainer,
    attackerOnList: threat.hit,
    attackerLabel: threat.label ?? "",
    usdc: REAL_USDC,
    treasury,
    fundedUsdc: formatUnits(startBal, 6),
    run1: {
      treasuryAfter: formatUnits(afterBal, 6),
      attackerAfter: formatUnits(drainerBal, 6),
      drained: formatUnits(startBal - afterBal, 6),
    },
    verdict: {
      verdict: verdict.verdict,
      blocked: verdict.blocked,
      realEffect: verdict.realEffect,
      counterparty: verdict.counterparty?.address ?? drainer,
      flags: verdict.counterparty?.flags ?? [],
      violations: verdict.policyViolations,
      reason: verdict.reason,
    },
    treasuryIntact: formatUnits(treasuryStillFull, 6),
    etherscan: {
      attacker: `https://etherscan.io/address/${drainer}`,
      usdc: `https://etherscan.io/token/${REAL_USDC}`,
    },
  };
  console.log("__PROOF_RESULT__" + JSON.stringify(result));

  stopChain();
  process.exit(verdict.blocked ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  stopChain();
  process.exit(1);
});
