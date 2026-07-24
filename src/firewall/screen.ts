// Screen module - checks counterparties against threat intel (local list +
// live ScamSniffer feed) and their real on-chain history when a chain is
// available, falling back to the mocked age table offline.
import type { CounterpartyScreen } from "../types.js";
import ages from "../../config/address-ages.json" with { type: "json" };
import { isThreat } from "./threatfeed.js";
import { getChain } from "../chain/anvil.js";

const AGES: Record<string, number> = ages.ages;
const FRESH_THRESHOLD: number = ages.freshThresholdDays;

export async function screenCounterparty(address: string): Promise<CounterpartyScreen> {
  const addr = address.toLowerCase();
  const flags: string[] = [];
  const threat = isThreat(addr);
  if (threat.hit) flags.push("threatlist");

  let ageDays: number | undefined;
  const chain = getChain();
  if (chain) {
    // Real on-chain history: an address with no code and no sent txs is fresh.
    const [nonce, code] = await Promise.all([
      chain.publicClient.getTransactionCount({ address: addr as `0x${string}` }),
      chain.publicClient.getCode({ address: addr as `0x${string}` }),
    ]);
    const hasHistory = nonce > 0 || (code !== undefined && code !== "0x");
    if (!hasHistory) flags.push("fresh_address");
  } else {
    ageDays = AGES[addr];
    if (ageDays === undefined || ageDays < FRESH_THRESHOLD) flags.push("fresh_address");
  }

  return { address: addr, flags, ageDays, threatLabel: threat.label };
}
