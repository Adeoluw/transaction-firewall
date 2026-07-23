// Assessment pipeline: simulate → decode → screen → policy → verdict.
import type { ProposedTx, Simulator, Verdict } from "../types.js";
import { screenCounterparty } from "./screen.js";
import { evaluatePolicy, getPolicy } from "./policy.js";
import { buildVerdict } from "./verdict.js";

export async function assess(
  tx: ProposedTx,
  policyId: string,
  simulator: Simulator,
): Promise<Verdict> {
  const policy = getPolicy(policyId);
  const sim = await simulator.simulate(tx);

  const counterparties = [
    ...new Set(sim.effects.map((e) => e.counterparty).filter((a): a is string => !!a)),
  ];
  const screens = await Promise.all(counterparties.map(screenCounterparty));

  const violations = evaluatePolicy(sim.effects, screens, policy);
  return buildVerdict(sim, screens, violations, policy, tx.claimed);
}
