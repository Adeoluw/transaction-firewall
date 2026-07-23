// Tier 2 co-signer: holds the treasury's signing key and will ONLY sign a
// transaction the firewall passes. This turns the verdict from advice into an
// enforced gate — an agent without this signature cannot move treasury funds.
//
// SAFETY: the key is a locally generated dev key for the demo chain / Sepolia
// testnet only. It is git-ignored and never used on mainnet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { ProposedTx, Simulator, Verdict } from "../types.js";
import { assess } from "../firewall/assess.js";
import { getChain } from "../chain/anvil.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY_FILE = join(ROOT, ".cosigner", "dev.key");

let account: PrivateKeyAccount | null = null;

/** Load (or generate on first run) the co-signer's testnet-only key. */
export function initCosigner(): PrivateKeyAccount {
  if (account) return account;
  let key: Hex;
  if (process.env.COSIGNER_PRIVATE_KEY) {
    key = process.env.COSIGNER_PRIVATE_KEY as Hex;
  } else if (existsSync(KEY_FILE)) {
    key = readFileSync(KEY_FILE, "utf8").trim() as Hex;
  } else {
    key = generatePrivateKey();
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, key);
  }
  account = privateKeyToAccount(key);
  return account;
}

export function cosignerAddress(): string {
  return initCosigner().address.toLowerCase();
}

export interface SignResult {
  signed: boolean;
  verdict: Verdict;
  rawTransaction?: Hex;
  txHash?: Hex;
}

/**
 * Assess, and only if the verdict is safe: sign with the treasury key and
 * (when the demo chain is up) broadcast. A blocked verdict returns unsigned.
 */
export async function signIfSafe(
  tx: ProposedTx,
  policyId: string,
  simulator: Simulator,
  broadcast: boolean,
): Promise<SignResult> {
  const verdict = await assess(tx, policyId, simulator);
  if (verdict.blocked) return { signed: false, verdict };

  const signer = initCosigner();
  const chain = getChain();
  if (!chain) {
    // No chain: sign a fully-formed static tx as proof of approval.
    const rawTransaction = await signer.signTransaction({
      to: tx.to as Hex,
      data: tx.data as Hex,
      value: BigInt(tx.value || "0"),
      chainId: tx.chainId,
      nonce: 0,
      gas: 200000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: "eip1559",
    });
    return { signed: true, verdict, rawTransaction };
  }

  const request = await chain.publicClient.prepareTransactionRequest({
    account: signer,
    to: tx.to as Hex,
    data: tx.data as Hex,
    value: BigInt(tx.value || "0"),
    chain: chain.chain,
  });
  const rawTransaction = await signer.signTransaction(request as never);
  if (!broadcast) return { signed: true, verdict, rawTransaction };

  const txHash = await chain.publicClient.sendRawTransaction({
    serializedTransaction: rawTransaction,
  });
  await chain.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { signed: true, verdict, rawTransaction, txHash };
}
