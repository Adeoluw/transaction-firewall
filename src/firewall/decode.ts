// Decode module - turns raw calldata into plain-language effects.
import { decodeFunctionData, formatUnits, maxUint256, parseAbi } from "viem";
import type { Effect, ProposedTx } from "../types.js";
import addresses from "../../config/addresses.json" with { type: "json" };
import { labelOf } from "../chain/registry.js";

const KNOWN_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 added)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

/** Approvals at or above this are treated as "near-unlimited". */
export const NEAR_UNLIMITED_THRESHOLD = maxUint256 / 2n;

const LABELS: Record<string, string> = addresses.labels;

// Real mainnet tokens the historical-replay proof touches, so effect
// descriptions show the correct symbol and decimals. Unknown tokens (incl. the
// demo's deployed USDC) default to 6-decimal "USDC".
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", decimals: 18 },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", decimals: 18 },
  // DRB (Base) - the token drained in the real Grok/Bankr agent hack.
  "0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2": { symbol: "DRB", decimals: 18 },
};

export function tokenMeta(tokenAddr?: string): { symbol: string; decimals: number } {
  return (tokenAddr && KNOWN_TOKENS[tokenAddr.toLowerCase()]) || { symbol: "USDC", decimals: 6 };
}

/** Format a token amount with the right symbol/decimals for the token. */
export function fmtTokenAmount(amount: bigint, tokenAddr?: string): string {
  if (amount === maxUint256) return "2^256-1 (UNLIMITED)";
  if (amount >= NEAR_UNLIMITED_THRESHOLD) return `${amount} (near-unlimited)`;
  const { symbol, decimals } = tokenMeta(tokenAddr);
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

export function labelFor(address: string): string {
  return labelOf(address) ?? LABELS[address.toLowerCase()] ?? shorten(address);
}

export function shorten(address: string): string {
  return address.length > 12 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
}

// Decode runs statically (no chain), so the token here is the tx target.
function fmtAmount(amount: bigint, tokenAddr?: string): string {
  return fmtTokenAmount(amount, tokenAddr);
}

/** Decode a proposed tx into its real effects. Pure and deterministic. */
export function decodeEffects(tx: ProposedTx): Effect[] {
  const effects: Effect[] = [];
  const value = BigInt(tx.value || "0");

  if (value > 0n) {
    effects.push({
      kind: "native_transfer",
      description: `send ${formatUnits(value, 18)} ETH to ${labelFor(tx.to)}`,
      counterparty: tx.to.toLowerCase(),
      amount: value.toString(),
    });
  }

  if (!tx.data || tx.data === "0x") return effects;

  let decoded;
  try {
    decoded = decodeFunctionData({ abi: KNOWN_ABI, data: tx.data as `0x${string}` });
  } catch {
    effects.push({
      kind: "unknown",
      description: `call unrecognized function ${tx.data.slice(0, 10)} on ${labelFor(tx.to)}`,
      counterparty: tx.to.toLowerCase(),
    });
    return effects;
  }

  const token = tx.to.toLowerCase();

  switch (decoded.functionName) {
    case "approve": {
      const [spender, amount] = decoded.args as readonly [string, bigint];
      const unlimited = amount >= NEAR_UNLIMITED_THRESHOLD;
      effects.push({
        kind: "approval",
        description: `approve(${shorten(spender)}, ${fmtAmount(amount, token)}) on ${labelFor(token)}`,
        token,
        counterparty: spender.toLowerCase(),
        amount: amount.toString(),
        unlimited,
        functionName: "approve",
      });
      break;
    }
    case "increaseAllowance": {
      const [spender, added] = decoded.args as readonly [string, bigint];
      const unlimited = added >= NEAR_UNLIMITED_THRESHOLD;
      effects.push({
        kind: "approval",
        description: `increaseAllowance(${shorten(spender)}, ${fmtAmount(added, token)}) on ${labelFor(token)} - same effect as approve`,
        token,
        counterparty: spender.toLowerCase(),
        amount: added.toString(),
        unlimited,
        functionName: "increaseAllowance",
      });
      break;
    }
    case "setApprovalForAll": {
      const [operator, approved] = decoded.args as readonly [string, boolean];
      if (approved) {
        effects.push({
          kind: "approval_all",
          description: `setApprovalForAll(${shorten(operator)}, true) on ${labelFor(token)} - grants control of ALL tokens in the collection`,
          token,
          counterparty: operator.toLowerCase(),
          unlimited: true,
          functionName: "setApprovalForAll",
        });
      }
      break;
    }
    case "transfer": {
      const [to, amount] = decoded.args as readonly [string, bigint];
      effects.push({
        kind: "transfer",
        description: `transfer ${fmtAmount(amount, token)} to ${labelFor(to)}`,
        token,
        counterparty: to.toLowerCase(),
        amount: amount.toString(),
        functionName: "transfer",
      });
      break;
    }
    case "transferFrom": {
      const [, to, amount] = decoded.args as readonly [string, string, bigint];
      effects.push({
        kind: "transfer",
        description: `transferFrom → ${fmtAmount(amount, token)} to ${labelFor(to)}`,
        token,
        counterparty: to.toLowerCase(),
        amount: amount.toString(),
        functionName: "transferFrom",
      });
      break;
    }
    case "swapExactTokensForTokens": {
      const [amountIn] = decoded.args as readonly [bigint, bigint, string[], string, bigint];
      effects.push({
        kind: "swap",
        description: `swap ${fmtAmount(amountIn, token)} via ${labelFor(token)}`,
        token,
        counterparty: token,
        amount: amountIn.toString(),
        functionName: "swapExactTokensForTokens",
      });
      break;
    }
  }

  return effects;
}
