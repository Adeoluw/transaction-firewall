// Verdict module — combines simulation, screening, and policy results into a
// final safe / suspicious / malicious verdict.
import type {
  CounterpartyScreen,
  Effect,
  Policy,
  SimulationResult,
  Verdict,
} from "../types.js";
import { fmtTokenAmount } from "./decode.js";
import { registry } from "../chain/registry.js";

export function buildVerdict(
  sim: SimulationResult,
  screens: CounterpartyScreen[],
  violations: string[],
  policy: Policy,
  claimed?: string,
): Verdict {
  const effects = sim.effects;
  const realEffect =
    effects.map((e) => e.description).join("; ") || "no state changes detected";
  const primary = screens[0];

  const threatHit = screens.find((s) => s.flags.includes("threatlist"));
  const hiddenUnlimited = effects.find(
    (e) =>
      (e.kind === "approval" || e.kind === "approval_all") &&
      e.unlimited &&
      violations.includes("counterparty_not_allowlisted"),
  );
  // Net treasury drain observed by balance-diff tracing — the strongest signal,
  // and one that doesn't depend on recognizing the calldata at all.
  const usdcDelta = sim.treasuryDelta ? BigInt(sim.treasuryDelta.usdc) : 0n;
  const drained = usdcDelta < 0n;
  const drainNote = drained
    ? `Simulation shows the treasury LOSES ${fmtTokenAmount(-usdcDelta, registry.usdc)} to ${sim.treasuryDelta!.recipients.map((r) => r.slice(0, 10) + "…").join(", ") || "an external address"}.`
    : "";
  // A tx we couldn't fully resolve — a revert on the fork, or an unrecognized
  // selector — is never "safe". Fail closed: the co-signer must not sign it.
  const unresolved = effects.find((e) => e.kind === "unknown");

  let verdict: Verdict["verdict"];
  let reason: string;

  if (unresolved) {
    verdict = "suspicious";
    reason = `Firewall could not verify this transaction's effects (${unresolved.description}). Failing closed — refusing to sign.`;
    return {
      verdict,
      reason,
      realEffect,
      claimed,
      counterparty: primary,
      policyViolations: [...violations, "unverifiable_effect"],
      effects,
      simulated: sim.simulated,
      backend: sim.backend,
      policyId: policy.id,
      blocked: true,
    };
  }

  if (threatHit || hiddenUnlimited || drained) {
    verdict = "malicious";
    const parts: string[] = [];
    if (claimed) parts.push(`Transaction claims "${claimed}" but its real effect is: ${realEffect}.`);
    else parts.push(`Real effect: ${realEffect}.`);
    if (drainNote) parts.push(drainNote);
    if (hiddenUnlimited) parts.push("It grants an unlimited token approval to a non-allowlisted address.");
    if (threatHit) parts.push(`Counterparty ${threatHit.address.slice(0, 10)}… is on the threat list (${threatHit.threatLabel ?? "known bad"}).`);
    reason = parts.join(" ");
  } else if (violations.length > 0) {
    verdict = "suspicious";
    reason = `Transaction violates policy "${policy.name}": ${violations.join(", ")}. Real effect: ${realEffect}.`;
  } else {
    verdict = "safe";
    reason = `No policy violations. Real effect: ${realEffect}.`;
  }

  return {
    verdict,
    reason,
    realEffect,
    claimed,
    counterparty: primary,
    policyViolations: drained && !violations.includes("treasury_drain")
      ? [...violations, "treasury_drain"]
      : violations,
    effects,
    simulated: sim.simulated,
    backend: sim.backend,
    policyId: policy.id,
    blocked: verdict !== "safe",
    treasuryDelta: sim.treasuryDelta,
  };
}
