// Simulate module - determines a tx's real effects behind a pluggable interface.
//
// Backends:
//  - AnvilSimulator: REAL simulation. Executes the proposed tx on the local
//    Anvil node (a Sepolia fork when the RPC is reachable) inside a snapshot,
//    reads the emitted Transfer/Approval logs - ground truth, not guesses -
//    then reverts the snapshot so nothing persists.
//  - DecodeSimulator: deterministic static decode. Always available, so the
//    firewall still answers with no chain running.
import { execFile } from "node:child_process";
import { formatUnits, maxUint256, parseEventLogs, parseAbi, type Hex } from "viem";
import type { BalanceDelta, Effect, ProposedTx, SimulationResult, Simulator } from "../types.js";
import { decodeEffects, fmtTokenAmount, labelFor, NEAR_UNLIMITED_THRESHOLD, shorten } from "./decode.js";
import {
  anvilBinary,
  executeAs,
  getChain,
  revert,
  snapshot,
  usdcBalance,
} from "../chain/anvil.js";
import { registry } from "../chain/registry.js";

export class DecodeSimulator implements Simulator {
  async available(): Promise<boolean> {
    return true;
  }
  async simulate(tx: ProposedTx): Promise<SimulationResult> {
    return { effects: decodeEffects(tx), backend: "decode", simulated: false };
  }
}

const ERC20_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
]);

// Token-aware amount formatting (correct symbol/decimals per token address).
const fmtAmount = fmtTokenAmount;

export class AnvilSimulator implements Simulator {
  private availability: Promise<boolean> | null = null;

  available(): Promise<boolean> {
    if (getChain()) return Promise.resolve(true);
    this.availability ??= new Promise((resolve) => {
      const bin = anvilBinary() ?? "anvil";
      const child = execFile(bin, ["--version"], { timeout: 3000 }, (err) =>
        resolve(!err),
      );
      child.on("error", () => resolve(false));
    });
    return this.availability;
  }

  async simulate(tx: ProposedTx): Promise<SimulationResult> {
    const chain = getChain();
    if (!chain) {
      // Anvil installed but node not running - static decode, honestly labeled.
      return { effects: decodeEffects(tx), backend: "decode", simulated: false };
    }

    const snap = await snapshot();
    const treasury = registry.treasury;
    try {
      // Balance-diff tracing: measure the treasury before and after so ANY
      // drain mechanism is caught, regardless of which selector caused it or
      // whether the calldata reveals anything.
      const [usdcBefore, ethBefore] = await Promise.all([
        usdcBalance(treasury),
        chain.publicClient.getBalance({ address: treasury as Hex }),
      ]);

      const receipt = await executeAs(tx.from, tx.to, tx.data as Hex, BigInt(tx.value || "0"));
      const effects: Effect[] = [];
      const recipients = new Set<string>();

      const logs = parseEventLogs({ abi: ERC20_EVENTS, logs: receipt.logs });
      for (const log of logs) {
        const token = log.address.toLowerCase();
        if (log.eventName === "Approval") {
          const { spender, value } = log.args as { owner: Hex; spender: Hex; value: bigint };
          effects.push({
            kind: "approval",
            description: `approve(${shorten(spender)}, ${fmtAmount(value, token)}) on ${labelFor(token)}`,
            token,
            counterparty: spender.toLowerCase(),
            amount: value.toString(),
            unlimited: value >= NEAR_UNLIMITED_THRESHOLD,
            functionName: "approve",
          });
        } else if (log.eventName === "ApprovalForAll") {
          const { owner, operator, approved } = log.args as {
            owner: Hex;
            operator: Hex;
            approved: boolean;
          };
          if (owner.toLowerCase() !== treasury) continue;
          if (!approved) continue;
          effects.push({
            kind: "approval_all",
            description: `setApprovalForAll(${shorten(operator)}, true) on ${labelFor(token)} - grants control of ALL tokens in the collection`,
            token,
            counterparty: operator.toLowerCase(),
            unlimited: true,
            functionName: "setApprovalForAll",
          });
        } else {
          const { from, to, value } = log.args as { from: Hex; to: Hex; value: bigint };
          if (from.toLowerCase() === treasury) recipients.add(to.toLowerCase());
          effects.push({
            kind: "transfer",
            description: `transfer ${fmtAmount(value, token)} to ${labelFor(to)}`,
            token,
            counterparty: to.toLowerCase(),
            amount: value.toString(),
            functionName: "transfer",
          });
        }
      }

      if (BigInt(tx.value || "0") > 0n) {
        effects.push({
          kind: "native_transfer",
          description: `send ${formatUnits(BigInt(tx.value), 18)} ETH to ${labelFor(tx.to)}`,
          counterparty: tx.to.toLowerCase(),
          amount: tx.value,
        });
      }

      const [usdcAfter, ethAfter] = await Promise.all([
        usdcBalance(treasury),
        chain.publicClient.getBalance({ address: treasury as Hex }),
      ]);
      const treasuryDelta: BalanceDelta = {
        usdc: (usdcAfter - usdcBefore).toString(),
        eth: (ethAfter - ethBefore).toString(),
        recipients: [...recipients],
      };

      // A net treasury outflow with no matching log-level effect still needs to
      // surface (e.g. exotic drains) - synthesize one so the verdict sees it.
      if (usdcAfter < usdcBefore && effects.every((e) => e.kind !== "transfer")) {
        const lost = usdcBefore - usdcAfter;
        effects.push({
          kind: "transfer",
          description: `treasury lost ${formatUnits(lost, 6)} USDC during execution`,
          token: registry.usdc,
          counterparty: recipients.values().next().value ?? tx.to.toLowerCase(),
          amount: lost.toString(),
          functionName: "transfer",
        });
      }

      if (effects.length === 0) {
        // Executed but moved no tokens (e.g. the demo router swap, which only
        // emits its own event). Fall back to decoded intent for context.
        return { effects: decodeEffects(tx), backend: "anvil", simulated: true, treasuryDelta };
      }
      return { effects, backend: "anvil", simulated: true, treasuryDelta };
    } catch (err) {
      return {
        effects: [
          {
            kind: "unknown",
            description: `transaction REVERTS on fork simulation (${trimRevert(err)})`,
            counterparty: tx.to.toLowerCase(),
          },
        ],
        backend: "anvil",
        simulated: true,
      };
    } finally {
      await revert(snap).catch(() => {});
    }
  }
}

function trimRevert(err: unknown): string {
  const msg = (err as Error).message ?? String(err);
  return msg.split("\n")[0].slice(0, 120);
}

/** Pick the best available backend (Anvil if installed, else static decode). */
export async function selectSimulator(): Promise<Simulator> {
  const anvil = new AnvilSimulator();
  if (await anvil.available()) return anvil;
  return new DecodeSimulator();
}
