// Policy module - evaluates decoded effects against a configured policy.
import type { CounterpartyScreen, Effect, Policy } from "../types.js";
import policiesFile from "../../config/policies.json" with { type: "json" };
import { registry } from "../chain/registry.js";

export const POLICIES: Policy[] = policiesFile.policies;

export function getPolicy(policyId: string): Policy {
  const policy = POLICIES.find((p) => p.id === policyId);
  if (!policy) throw new Error(`Unknown policy: ${policyId}`);
  return policy;
}

/** Evaluate effects + screening against a policy. Returns violation codes. */
export function evaluatePolicy(
  effects: Effect[],
  screens: CounterpartyScreen[],
  policy: Policy,
): string[] {
  const violations = new Set<string>();
  // Config allowlist plus the runtime addresses of the deployed router/token
  // (contract addresses change per fork bootstrap).
  // Config allowlist plus deployed contracts. NOTE: the malicious EvilRouter is
  // intentionally allowlisted - the point is that simulation catches its drain
  // from the *observed effects* even though the tx target passes the allowlist.
  const allowlist = new Set([
    ...policy.allowlist.map((a) => a.toLowerCase()),
    registry.router,
    registry.usdc,
    registry.evilRouter,
    registry.nft,
  ]);
  const maxValue = BigInt(policy.maxValuePerTx);
  const treasuryCap =
    (BigInt(policy.treasuryBalance) * BigInt(policy.maxTreasuryPctPerTx)) / 100n;

  const isApproval = (k: Effect["kind"]) => k === "approval" || k === "approval_all";
  const movesFunds = (k: Effect["kind"]) =>
    isApproval(k) || k === "transfer" || k === "native_transfer";

  for (const effect of effects) {
    // approval_all (setApprovalForAll) is always an unlimited-style grant.
    if (policy.noUnlimitedApprovals && isApproval(effect.kind) && effect.unlimited) {
      violations.add("no_unlimited_approvals");
    }
    if (effect.counterparty && movesFunds(effect.kind) && !allowlist.has(effect.counterparty)) {
      violations.add("counterparty_not_allowlisted");
    }
    if (effect.amount !== undefined && !isApproval(effect.kind)) {
      const amount = BigInt(effect.amount);
      if (amount > maxValue) violations.add("max_value_per_tx_exceeded");
      if (amount > treasuryCap) violations.add("treasury_pct_cap_exceeded");
    }
  }

  for (const screen of screens) {
    if (screen.flags.includes("threatlist")) violations.add("counterparty_on_threatlist");
  }

  return [...violations];
}
