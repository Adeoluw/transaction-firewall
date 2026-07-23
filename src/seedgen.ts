// Builds the demo sample transactions for a given address set. Used by
// scripts/seed.ts (static committed bytes) and by the server at runtime
// (re-encoded against the actually-deployed contract addresses).
import { encodeFunctionData, maxUint256, parseAbi, parseUnits } from "viem";

const abi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 added)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transfer(address to, uint256 amount)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function batchRebalance(uint256 keepAmount)",
]);

export interface SampleAddresses {
  treasury: string;
  attacker: string;
  router: string;
  usdc: string;
  evilRouter: string;
  nft: string;
  tokenB?: string;
}

export function buildSamples(a: SampleAddresses) {
  const tokenB = a.tokenB ?? "0x00b000000000000000000000000000000000b000";
  const base = { from: a.treasury, value: "0", chainId: 31337 };
  return [
    {
      id: "hidden-approval",
      name: "🎯 Hidden approval drain (hero payload)",
      claimed: "Swap 100 USDC → TOKEN via Router",
      expected: "malicious",
      tx: {
        ...base,
        to: a.usdc,
        data: encodeFunctionData({
          abi,
          functionName: "approve",
          args: [a.attacker as `0x${string}`, maxUint256],
        }),
      },
    },
    {
      id: "safe-swap",
      name: "✅ Legit swap via allowlisted router",
      claimed: "Swap 100 USDC → TOKEN via Router",
      expected: "safe",
      tx: {
        ...base,
        to: a.router,
        data: encodeFunctionData({
          abi,
          functionName: "swapExactTokensForTokens",
          args: [
            parseUnits("100", 6),
            parseUnits("99", 6),
            [a.usdc as `0x${string}`, tokenB as `0x${string}`],
            a.treasury as `0x${string}`,
            9999999999n,
          ],
        }),
      },
    },
    {
      id: "safe-approve",
      name: "✅ Bounded approve to allowlisted router",
      claimed: "Approve Router to spend 100 USDC",
      expected: "safe",
      tx: {
        ...base,
        to: a.usdc,
        data: encodeFunctionData({
          abi,
          functionName: "approve",
          args: [a.router as `0x${string}`, parseUnits("100", 6)],
        }),
      },
    },
    {
      id: "over-cap-transfer",
      name: "⚠️ Over-cap transfer (legit but too big)",
      claimed: "Transfer 900 USDC to Router",
      expected: "suspicious",
      tx: {
        ...base,
        to: a.usdc,
        data: encodeFunctionData({
          abi,
          functionName: "transfer",
          args: [a.router as `0x${string}`, parseUnits("900", 6)],
        }),
      },
    },
    {
      id: "lying-contract",
      name: "🥷 Lying router — clean calldata, drains on execution (sim-only catch)",
      claimed: "Swap 100 USDC → TOKEN via DEXMax (allowlisted)",
      expected: "malicious",
      // Only real fork simulation catches this; static decode is fooled and
      // sees a harmless swap.
      simOnly: true,
      offlineExpected: "safe",
      tx: {
        ...base,
        to: a.evilRouter, // an ALLOWLISTED router; calldata is a normal swap
        data: encodeFunctionData({
          abi,
          functionName: "swapExactTokensForTokens",
          args: [
            parseUnits("100", 6),
            parseUnits("99", 6),
            [a.usdc as `0x${string}`, (a.tokenB ?? a.router) as `0x${string}`],
            a.treasury as `0x${string}`,
            9999999999n,
          ],
        }),
      },
    },
    {
      id: "increase-allowance",
      name: "🎭 increaseAllowance — unlimited via a non-approve selector",
      claimed: "Top up Router allowance",
      expected: "malicious",
      tx: {
        ...base,
        to: a.usdc,
        data: encodeFunctionData({
          abi,
          functionName: "increaseAllowance",
          args: [a.attacker as `0x${string}`, maxUint256],
        }),
      },
    },
    {
      id: "approve-all-nft",
      name: "🖼️ setApprovalForAll — hands over every NFT",
      claimed: "List NFT collection on marketplace",
      expected: "malicious",
      tx: {
        ...base,
        to: a.nft,
        data: encodeFunctionData({
          abi,
          functionName: "setApprovalForAll",
          args: [a.attacker as `0x${string}`, true],
        }),
      },
    },
    {
      id: "batch-rider",
      name: "🎁 Batch rider — real rebalance + hidden drain in one call",
      claimed: "Rebalance 10 USDC to Router",
      expected: "malicious",
      // Unknown selector to a static decoder → fails closed (suspicious/blocked)
      // offline; simulation reveals the full malicious drain.
      simOnly: true,
      offlineExpected: "suspicious",
      tx: {
        ...base,
        to: a.evilRouter,
        data: encodeFunctionData({
          abi,
          functionName: "batchRebalance",
          args: [parseUnits("10", 6)],
        }),
      },
    },
  ];
}
