// HISTORICAL REPLAY PROOF
// =======================
// Replays the EXACT bytes of a REAL, on-chain theft transaction and shows the
// firewall flag it MALICIOUS. For a chosen real attack (config/real-attacks.json):
//   1. fetch the transaction's exact calldata by hash from mainnet,
//   2. fork Ethereum mainnet at the block just before it,
//   3. replay the identical bytes from the original sender — reproducing the
//      real drain (real victim really loses real tokens on the fork),
//   4. run the identical transaction through the firewall → MALICIOUS.
//
// Every hash/address is public and verifiable on Etherscan. Runs on a throwaway
// fork; no live system is touched and no real funds move.
//
// Usage: tsx scripts/historical-replay.ts [attackIndex]
import { formatUnits, type Hex } from "viem";
import realAttacks from "../config/real-attacks.json" with { type: "json" };

process.env.ANVIL_PORT ||= "8601";

// Which real attack to replay (env or argv) — determines the chain, so it must
// be resolved before importing the chain module (it reads the RPC on load).
const attackIndex = Number(process.argv[2] ?? process.env.ATTACK_INDEX ?? 0);
const selectedAttack = realAttacks.attacks[attackIndex] ?? realAttacks.attacks[0];
const CHAIN = (selectedAttack as { chain?: string }).chain ?? "ethereum";

// Replaying at a historical block needs an ARCHIVE node (old-state access).
// Public archive endpoints per chain, probed for a live one so a rate-limited
// node doesn't break the demo.
const ARCHIVE_RPCS: Record<string, string[]> = {
  ethereum: ["https://eth-mainnet.public.blastapi.io", "https://eth.drpc.org"],
  base: ["https://base-mainnet.public.blastapi.io", "https://base.drpc.org", "https://mainnet.base.org"],
};
const EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
};
async function pickArchiveRpc(candidates: string[]): Promise<string> {
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok && (await res.json()).result) return url;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}
process.env.MAINNET_RPC_URL ||= await pickArchiveRpc(ARCHIVE_RPCS[CHAIN] ?? ARCHIVE_RPCS.ethereum);
const explorer = EXPLORER[CHAIN] ?? EXPLORER.ethereum;

const { executeAs, resetChain, startForkAt, stopChain, usdcBalance } = await import(
  "../src/chain/anvil.js"
);
const { assess } = await import("../src/firewall/assess.js");
const { AnvilSimulator } = await import("../src/firewall/simulate.js");
const { initThreatIntel } = await import("../src/firewall/threatfeed.js");

const MAINNET_RPC = process.env.MAINNET_RPC_URL;
const JSON_MODE = process.env.PROOF_JSON === "1";
const log = (...a: unknown[]) => !JSON_MODE && console.log(...a);
const line = "─".repeat(72);
const h = (s: string) => log(`\n${line}\n${s}\n${line}`);

interface RpcTx {
  from: string;
  to: string;
  input: string;
  value: string;
}

async function fetchTx(hash: string): Promise<RpcTx> {
  const res = await fetch(MAINNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }),
    signal: AbortSignal.timeout(20000),
  });
  const json = (await res.json()) as { result: RpcTx | null };
  if (!json.result) throw new Error(`transaction ${hash} not found on ${CHAIN}`);
  return json.result;
}

async function main() {
  const attack = selectedAttack;
  const chainName = CHAIN === "base" ? "Base" : "Ethereum";

  h(`HISTORICAL REPLAY — ${attack.title}`);
  await initThreatIntel();

  log(`Real theft transaction (verify on ${CHAIN === "base" ? "Basescan" : "Etherscan"}):`);
  log(`  ${explorer}/tx/${attack.hash}`);
  log(`  ${attack.description}`);
  log(`\nAttacker: ${attack.drainer}`);
  log(`Victim:   ${attack.victim}`);
  log(`Token:    ${attack.tokenSymbol} ${attack.token}`);

  h(`Forking real ${chainName} at block ${attack.block - 1} (just before the theft)…`);
  const chain = await startForkAt(attack.block - 1, {
    drainer: attack.drainer,
    victim: attack.victim,
    token: attack.token,
    tokenLabel: `${attack.tokenSymbol} (REAL, ${chainName})`,
  });
  if (!chain) {
    console.error(`Could not fork ${chainName} (need Foundry + network).`);
    process.exit(1);
  }

  const realTx = await fetchTx(attack.hash);
  const proposedTx = {
    from: realTx.from,
    to: realTx.to,
    data: realTx.input,
    value: BigInt(realTx.value).toString(),
    chainId: chain.chain.id,
    claimed: `${attack.method}(…) — looks routine`,
  };

  const victimBefore = await usdcBalance(attack.victim);
  log(`Victim's ${attack.tokenSymbol} balance at that block: ${formatUnits(victimBefore, attack.tokenDecimals)}`);

  // ── RUN 1: no firewall — replay the EXACT real bytes, the theft happens ──────
  h("RUN 1 — NO FIREWALL: replay the exact real transaction");
  await executeAs(proposedTx.from, proposedTx.to, proposedTx.data as Hex, BigInt(proposedTx.value));
  const victimAfter = await usdcBalance(attack.victim);
  const stolen = victimBefore - victimAfter;
  log(`  Victim ${attack.tokenSymbol}: ${formatUnits(victimBefore, attack.tokenDecimals)} → ${formatUnits(victimAfter, attack.tokenDecimals)}`);
  log(`  💀 ${formatUnits(stolen, attack.tokenDecimals)} ${attack.tokenSymbol} REALLY moved — this is the actual historical theft, reproduced.`);

  await resetChain();

  // ── RUN 2: with firewall — same bytes, assessed and refused ─────────────────
  h("RUN 2 — WITH FIREWALL: the identical bytes through /assess");
  const verdict = await assess(proposedTx, "treasury-default", new AnvilSimulator());
  log(`Real effect:  ${verdict.realEffect}`);
  log(`Counterparty: ${verdict.counterparty?.address} [${verdict.counterparty?.flags.join(", ")}]`);
  log(`Violations:   ${verdict.policyViolations.join(", ")}`);
  log(`VERDICT: ${verdict.verdict.toUpperCase()} — ${verdict.blocked ? "BLOCKED" : "allowed"}`);
  log(`Reason: ${verdict.reason}`);

  const result = {
    attack,
    chain: CHAIN,
    explorerTx: `${explorer}/tx/${attack.hash}`,
    explorerDrainer: `${explorer}/address/${attack.drainer}`,
    victimBefore: formatUnits(victimBefore, attack.tokenDecimals),
    stolen: formatUnits(stolen, attack.tokenDecimals),
    verdict: {
      verdict: verdict.verdict,
      blocked: verdict.blocked,
      realEffect: verdict.realEffect,
      counterparty: verdict.counterparty?.address ?? attack.drainer,
      flags: verdict.counterparty?.flags ?? [],
      violations: verdict.policyViolations,
      reason: verdict.reason,
    },
  };
  if (JSON_MODE) console.log("__PROOF_RESULT__" + JSON.stringify(result));

  stopChain();
  process.exit(verdict.blocked && stolen > 0n ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  stopChain();
  process.exit(1);
});
