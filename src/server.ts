// Transaction Firewall HTTP service + demo frontend host.
//
// Startup: boots a real local chain (Anvil, Sepolia fork when reachable),
// deploys the demo token + router, loads live threat intel, and initializes
// the co-signer. Every layer degrades gracefully so the demo runs offline.
import express from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeFunctionData, formatUnits, maxUint256, parseAbi, parseUnits, type Hex } from "viem";
import { assess } from "./firewall/assess.js";
import { AnvilSimulator, selectSimulator } from "./firewall/simulate.js";
import { POLICIES } from "./firewall/policy.js";
import { initThreatIntel, threatIntelStatus } from "./firewall/threatfeed.js";
import { cosignerAddress, signIfSafe } from "./cosigner/index.js";
import {
  executeAs,
  getChain,
  resetChain,
  startChain,
  usdcAllowance,
  usdcBalance,
} from "./chain/anvil.js";
import { registry } from "./chain/registry.js";
import { buildSamples } from "./seedgen.js";
import { runAgent } from "./agent/trader.js";
import { llmStatus } from "./agent/llm.js";
import type { ChatMessage } from "./agent/llm.js";
import type { ProposedTx } from "./types.js";
import seed from "../seed/payloads.json" with { type: "json" };
import realAttacks from "../config/real-attacks.json" with { type: "json" };

const app = express();
app.use(express.json());

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
app.use(express.static(join(root, "public")));

// Fill in transaction defaults the caller may omit (tx fields win).
function withDefaults(tx: ProposedTx): ProposedTx {
  return {
    from: tx.from || registry.treasury,
    value: tx.value ?? "0",
    chainId: tx.chainId ?? 31337,
    to: tx.to,
    data: tx.data,
    claimed: tx.claimed,
  };
}

let simulatorPromise = selectSimulator();

// Primary endpoint: assess a proposed transaction before it is signed.
app.post("/assess", async (req, res) => {
  try {
    const { tx, policyId } = req.body as { tx: ProposedTx; policyId?: string };
    if (!tx?.to || tx.data === undefined) {
      return res.status(400).json({ error: "tx.to and tx.data are required" });
    }
    const verdict = await assess(
      withDefaults(tx),
      policyId ?? "treasury-default",
      await simulatorPromise,
    );
    res.json(verdict);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Tier 2 enforcement: sign only if the firewall passes the tx.
app.post("/sign", async (req, res) => {
  try {
    const { tx, policyId, broadcast } = req.body as {
      tx: ProposedTx;
      policyId?: string;
      broadcast?: boolean;
    };
    if (!tx?.to || tx.data === undefined) {
      return res.status(400).json({ error: "tx.to and tx.data are required" });
    }
    const result = await signIfSafe(
      withDefaults(tx),
      policyId ?? "treasury-default",
      await simulatorPromise,
      broadcast ?? true,
    );
    res.status(result.signed ? 200 : 403).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Demo helpers ---------------------------------------------------------------

function currentSamples() {
  if (!getChain()) return seed; // offline: committed bytes
  return {
    generatedBy: "runtime (live chain addresses)",
    addresses: { ...registry },
    samples: buildSamples(registry),
  };
}

app.get("/api/samples", (_req, res) => res.json(currentSamples()));
app.get("/api/policies", (_req, res) => res.json(POLICIES));

app.get("/api/chain", async (_req, res) => {
  const chain = getChain();
  if (!chain) {
    return res.json({ running: false, threatIntel: threatIntelStatus() });
  }
  const [treasuryUsdc, attackerUsdc, attackerAllowance] = await Promise.all([
    usdcBalance(registry.treasury),
    usdcBalance(registry.attacker),
    usdcAllowance(registry.treasury, registry.attacker),
  ]);
  res.json({
    running: true,
    forked: chain.forked,
    addresses: { ...registry },
    treasuryUsdc: formatUnits(treasuryUsdc, 6),
    attackerUsdc: formatUnits(attackerUsdc, 6),
    attackerAllowance:
      attackerAllowance >= maxUint256 / 2n ? "UNLIMITED" : formatUnits(attackerAllowance, 6),
    threatIntel: threatIntelStatus(),
  });
});

// Run 1: execute unchecked, for real, on the local chain — then let the
// "attacker bot" exploit whatever the tx granted it.
app.post("/api/execute", async (req, res) => {
  try {
    if (!getChain()) return res.status(409).json({ error: "chain not running (offline mode)" });
    const { tx } = req.body as { tx: ProposedTx };
    const steps: string[] = [];

    const receipt = await executeAs(
      tx.from || registry.treasury,
      tx.to,
      tx.data as Hex,
      BigInt(tx.value || "0"),
    );
    steps.push(`executed on-chain in block ${receipt.blockNumber} (status: ${receipt.status})`);

    // Attacker bot: watches the mempool; the instant it has an allowance it drains.
    const allowance = await usdcAllowance(registry.treasury, registry.attacker);
    let drained = "0";
    if (allowance > 0n) {
      const balance = await usdcBalance(registry.treasury);
      const take = allowance < balance ? allowance : balance;
      if (take > 0n) {
        const drainData = encodeFunctionData({
          abi: parseAbi(["function transferFrom(address from, address to, uint256 amount)"]),
          functionName: "transferFrom",
          args: [registry.treasury as Hex, registry.attacker as Hex, take],
        });
        const drainReceipt = await executeAs(registry.attacker, registry.usdc, drainData, 0n);
        drained = formatUnits(take, 6);
        steps.push(
          `attacker used its allowance: transferFrom(treasury → attacker, ${drained} USDC) in block ${drainReceipt.blockNumber}`,
        );
      }
    }

    const [treasuryUsdc, attackerUsdc] = await Promise.all([
      usdcBalance(registry.treasury),
      usdcBalance(registry.attacker),
    ]);
    res.json({
      steps,
      drained,
      treasuryUsdc: formatUnits(treasuryUsdc, 6),
      attackerUsdc: formatUnits(attackerUsdc, 6),
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post("/api/reset", async (_req, res) => {
  await resetChain();
  res.json({ ok: true });
});

// Real-world proofs run as ISOLATED child processes (their own mainnet fork on
// a separate port) so they never collide with this server's Sepolia chain.
function runProofChild(script: string, extraEnv: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      cwd: root,
      shell: true,
      env: { ...process.env, PROOF_JSON: "1", ...extraEnv },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const marker = out.indexOf("__PROOF_RESULT__");
      if (marker === -1) {
        return reject(new Error(`proof produced no result (exit ${code}). ${err.slice(-400)}`));
      }
      const jsonLine = out.slice(marker + "__PROOF_RESULT__".length).split("\n")[0];
      try {
        resolve(JSON.parse(jsonLine));
      } catch (e) {
        reject(new Error(`could not parse proof result: ${(e as Error).message}`));
      }
    });
  });
}

// Serialize concurrent clicks per proof kind onto a single run.
const proofRuns = new Map<string, Promise<unknown>>();
function serializedProof(key: string, run: () => Promise<unknown>): Promise<unknown> {
  if (!proofRuns.has(key)) proofRuns.set(key, run().finally(() => proofRuns.delete(key)));
  return proofRuns.get(key)!;
}

// Representative attack on real mainnet with a real blocklisted address.
app.post("/api/proof", async (_req, res) => {
  try {
    res.json(await serializedProof("proof", () => runProofChild("proof")));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Historical replay: the exact bytes of a real, on-chain theft.
app.get("/api/proof/attacks", (_req, res) => res.json(realAttacks));

app.post("/api/proof/historical", async (req, res) => {
  try {
    const index = Number((req.body as { index?: number })?.index ?? 0);
    res.json(
      await serializedProof(`replay-${index}`, () =>
        runProofChild("replay", { ATTACK_INDEX: String(index) }),
      ),
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Prompt-injection playground -------------------------------------------
// A person chats with the (gullible) Trader Agent and tries to talk it into
// moving funds. Whatever tx the agent is tricked into producing is routed
// through the firewall co-signer when `firewall` is true — showing the
// firewall catch an attack the agent itself fell for.
app.get("/api/agent/status", async (_req, res) => {
  res.json(await llmStatus(true));
});

app.post("/api/agent", async (req, res) => {
  try {
    const { message, history, firewall, technique } = req.body as {
      message: string;
      history?: ChatMessage[];
      firewall?: boolean;
      technique?: "naive" | "encoded" | "indirect";
    };
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const turn = await runAgent((history ?? []).slice(-8), message, technique ?? "naive");
    const base = { steps: turn.steps, refused: turn.refused, technique: turn.technique };

    // No action decided — the agent talked, or its own guardrail refused.
    if (!turn.tx) {
      return res.json({ reply: turn.decision.reply, decision: turn.decision, tx: null, ...base });
    }

    if (firewall) {
      // Agent is protected: route its tx through the co-signer.
      const result = await signIfSafe(
        turn.tx,
        "treasury-default",
        await simulatorPromise,
        true,
      );
      return res.json({
        reply: turn.decision.reply,
        decision: turn.decision,
        tx: turn.tx,
        ...base,
        protected: true,
        signed: result.signed,
        verdict: result.verdict,
        txHash: result.txHash ?? null,
      });
    }

    // Agent is unprotected: assess for display, then execute for real if a
    // chain is running (so a successful injection actually drains funds).
    const verdict = await assess(turn.tx, "treasury-default", await simulatorPromise);
    let executed = false;
    let drainInfo: { drained: string; treasuryUsdc: string; attackerUsdc: string } | null = null;
    if (getChain()) {
      await executeAs(turn.tx.from, turn.tx.to, turn.tx.data as Hex, 0n);
      const allowance = await usdcAllowance(registry.treasury, registry.attacker);
      let drained = "0";
      if (allowance > 0n) {
        const balance = await usdcBalance(registry.treasury);
        const take = allowance < balance ? allowance : balance;
        if (take > 0n) {
          const drainData = encodeFunctionData({
            abi: parseAbi(["function transferFrom(address from, address to, uint256 amount)"]),
            functionName: "transferFrom",
            args: [registry.treasury as Hex, registry.attacker as Hex, take],
          });
          await executeAs(registry.attacker, registry.usdc, drainData, 0n);
          drained = formatUnits(take, 6);
        }
      }
      drainInfo = {
        drained,
        treasuryUsdc: formatUnits(await usdcBalance(registry.treasury), 6),
        attackerUsdc: formatUnits(await usdcBalance(registry.attacker), 6),
      };
      executed = true;
    }
    return res.json({
      reply: turn.decision.reply,
      decision: turn.decision,
      tx: turn.tx,
      ...base,
      protected: false,
      executed,
      verdict,
      drain: drainInfo,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Re-encode calldata from simple fields for the live-edit control.
const encodeAbi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
]);
app.post("/api/encode", (req, res) => {
  try {
    const { functionName, address, amount } = req.body as {
      functionName: "approve" | "transfer";
      address: string;
      amount: string; // human units ("100") or "unlimited"
    };
    const value = amount === "unlimited" ? maxUint256 : parseUnits(amount, 6);
    const data = encodeFunctionData({
      abi: encodeAbi,
      functionName,
      args: [address as Hex, value],
    });
    res.json({ data });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Startup --------------------------------------------------------------------

const port = Number(process.env.PORT) || 4780;
app.listen(port, async () => {
  console.log(`Transaction Firewall running at http://localhost:${port}`);

  await initThreatIntel();
  const intel = threatIntelStatus();
  console.log(`Threat intel: ${intel.entries} addresses (${intel.source})`);

  const treasury = cosignerAddress();
  console.log(`Co-signer / treasury wallet: ${treasury} (testnet-only dev key)`);

  const llm = await llmStatus(true);
  console.log(
    `Trader Agent LLM: ${llm.available ? `${llm.model} (Ollama)` : `deterministic fallback (${llm.reason})`}`,
  );

  const anvilPresent = await new AnvilSimulator().available();
  if (anvilPresent) {
    console.log("Starting Anvil chain (Sepolia fork if RPC reachable)…");
    const chain = await startChain(treasury);
    if (chain) {
      simulatorPromise = selectSimulator(); // re-select now that the chain is up
      console.log(`Chain up: ${chain.forked ? "SEPOLIA FORK" : "local anvil"}`);
      console.log(`  USDC deployed at   ${registry.usdc}`);
      console.log(`  Router deployed at ${registry.router}`);
      console.log(`  Treasury funded:   10,000 USDC + 100 ETH`);
      console.log("Simulation backend: anvil (real fork execution)");
    } else {
      console.log("Anvil failed to start — simulation backend: decode fallback");
    }
  } else {
    console.log("Anvil not found — simulation backend: decode fallback");
  }
});
