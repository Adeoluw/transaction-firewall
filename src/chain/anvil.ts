// Real chain layer: spawns a local Anvil node (forking Sepolia when the RPC
// is reachable), deploys the demo token + router, funds the treasury, and
// exposes execution/snapshot helpers used by the simulator, the co-signer,
// and the demo endpoints.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createTestClient,
  defineChain,
  http,
  maxUint256,
  parseUnits,
  publicActions,
  walletActions,
  type Abi,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import usdcArtifact from "./DemoUSDC.artifact.json" with { type: "json" };
import routerArtifact from "./DemoRouter.artifact.json" with { type: "json" };
import evilArtifact from "./EvilRouter.artifact.json" with { type: "json" };
import nftArtifact from "./DemoNFT.artifact.json" with { type: "json" };
import { registry, setAddress } from "./registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ANVIL_PORT = Number(process.env.ANVIL_PORT) || 8545;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const MAINNET_RPC = process.env.MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com";

// Real Ethereum mainnet addresses — used by the real-world proof (mainnet
// fork). Anyone can verify these on Etherscan.
export const REAL_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // Circle USDC
const USDC_WHALE = "0x55FE002aefF02F77364de339a1292923A15844B8"; // Circle: ~$66M USDC

export interface StartChainOptions {
  /** "sepolia" (default demo) or "mainnet" (real-world proof, real USDC). */
  network?: "sepolia" | "mainnet";
  /** Address to treat as the attacker (a real drainer in mainnet mode). */
  attacker?: string;
}

// Anvil's first dev account — used only as deployer/minter on the local node.
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d2238da4c8c8c8b1e7bc72ee1e176ba55a3fb1a0" as Hex;

export const USDC_ABI = usdcArtifact.abi as Abi;
export const ROUTER_ABI = routerArtifact.abi as Abi;
export const EVIL_ABI = evilArtifact.abi as Abi;
export const NFT_ABI = nftArtifact.abi as Abi;

export interface ChainHandle {
  forked: boolean;
  chain: Chain;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof makeTestClient>;
}

let chain: ChainHandle | null = null;
let anvilProcess: ChildProcess | null = null;
let bootSnapshot: Hex | null = null;

export function getChain(): ChainHandle | null {
  return chain;
}

export function anvilBinary(): string | null {
  const local = join(ROOT, "tools", "foundry", "anvil.exe");
  if (existsSync(local)) return local;
  return null; // PATH resolution handled by AnvilSimulator.available() elsewhere
}

// Build a viem chain object using the node's ACTUAL chain id. A Sepolia fork
// keeps id 11155111, a bare anvil is 31337 — hardcoding either causes every
// tx to fail viem's chain-id guard.
function makeChain(chainId: number): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 11155111 ? "Sepolia Fork (local)" : "Local Anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
}

// Generous timeout: a historical fork lazily fetches old state from the
// archive RPC during execution, which can be slow for complex transactions.
const LOCAL_TRANSPORT = () => http(RPC_URL, { timeout: 90_000 });

function makeTestClient(chainObj: Chain) {
  return createTestClient({ chain: chainObj, mode: "anvil", transport: LOCAL_TRANSPORT() })
    .extend(publicActions)
    .extend(walletActions);
}

async function fetchChainId(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const json = await res.json();
  return Number(json.result);
}

async function rpcReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForAnvil(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await rpcReachable(RPC_URL)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function spawnAnvil(forkUrl: string | null, forkBlock?: number): Promise<boolean> {
  const bin = anvilBinary() ?? "anvil";
  const args = ["--port", String(ANVIL_PORT), "--auto-impersonate"];
  if (forkUrl) args.push("--fork-url", forkUrl);
  if (forkBlock !== undefined) args.push("--fork-block-number", String(forkBlock));
  anvilProcess = spawn(bin, args, { stdio: "ignore" });
  anvilProcess.on("exit", () => (anvilProcess = null));
  const up = await waitForAnvil();
  if (!up && anvilProcess) {
    anvilProcess.kill();
    anvilProcess = null;
  }
  return up;
}

export interface ForkAtOptions {
  drainer: string;
  victim: string;
  token: string;
  tokenLabel: string;
}

/**
 * Bare mainnet fork pinned to a historical block — no demo contracts deployed.
 * Used by the historical-replay proof to reconstruct the exact on-chain state
 * just before a real theft, so the real transaction's bytes can be replayed.
 */
export async function startForkAt(
  blockNumber: number,
  opts: ForkAtOptions,
): Promise<ChainHandle | null> {
  if (!(await rpcReachable(MAINNET_RPC))) return null;
  const started = await spawnAnvil(MAINNET_RPC, blockNumber);
  if (!started) return null;

  const chainId = await fetchChainId();
  const chainObj = makeChain(chainId);
  const publicClient = createPublicClient({ chain: chainObj, transport: LOCAL_TRANSPORT() });
  const testClient = makeTestClient(chainObj);

  // Give the replayed sender gas without disturbing token balances.
  for (const addr of [opts.drainer, opts.victim]) {
    await testClient.setBalance({ address: addr as Hex, value: parseUnits("10", 18) });
  }

  // Point the registry at the real victim/attacker/token so screening,
  // balance-diff, and labels all reflect the real incident.
  setAddress("treasury", opts.victim, "Victim wallet (real theft)");
  setAddress("attacker", opts.drainer, "Attacker wallet (from the real incident)");
  setAddress("usdc", opts.token, opts.tokenLabel);

  chain = { forked: true, chain: chainObj, publicClient, testClient };
  bootSnapshot = await testClient.snapshot();
  return chain;
}

/**
 * Start anvil and set up the demo world, deploying the router/evil/NFT
 * contracts and funding the treasury with 10,000 USDC.
 *
 * - "sepolia" (default): forks Sepolia, deploys a demo USDC token and mints.
 * - "mainnet": forks REAL Ethereum, uses the REAL USDC contract, and funds the
 *   treasury by moving real USDC from a whale — for the real-world proof.
 */
export async function startChain(
  treasuryAddress: string,
  opts: StartChainOptions = {},
): Promise<ChainHandle | null> {
  const network = opts.network ?? "sepolia";
  const rpc = network === "mainnet" ? MAINNET_RPC : SEPOLIA_RPC;
  const attacker = (opts.attacker ?? registry.attacker).toLowerCase();

  const forkable = await rpcReachable(rpc);
  let started = await spawnAnvil(forkable ? rpc : null);
  let forked = forkable && started;
  if (!started && forkable) {
    started = await spawnAnvil(null); // fork failed mid-boot; run locally
    forked = false;
  }
  if (!started) return null;
  // The real-world proof is meaningless without the real chain state.
  if (network === "mainnet" && !forked) {
    stopChain();
    return null;
  }

  const chainId = await fetchChainId();
  const chainObj = makeChain(chainId);
  const publicClient = createPublicClient({ chain: chainObj, transport: LOCAL_TRANSPORT() });
  const testClient = makeTestClient(chainObj);
  const deployer = privateKeyToAccount(DEPLOYER_KEY);

  const eth = parseUnits("100", 18);
  for (const addr of [deployer.address, treasuryAddress, attacker, USDC_WHALE]) {
    await testClient.setBalance({ address: addr as Hex, value: eth });
  }

  const deploy = async (abi: Abi, bytecode: Hex) => {
    const hash = await testClient.deployContract({ abi, bytecode, account: deployer, chain: chainObj });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  };

  // Token: deploy a demo USDC on Sepolia; use the REAL USDC on mainnet.
  let usdc: string;
  if (network === "mainnet") {
    usdc = REAL_USDC;
    // Fund the treasury with REAL USDC by impersonating a whale on the fork.
    const fundHash = await testClient.writeContract({
      address: REAL_USDC as Hex,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [treasuryAddress as Hex, parseUnits("10000", 6)],
      account: USDC_WHALE as Hex,
      chain: chainObj,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
  } else {
    usdc = await deploy(USDC_ABI, usdcArtifact.bytecode as Hex);
    const mintHash = await testClient.writeContract({
      address: usdc as Hex,
      abi: USDC_ABI,
      functionName: "mint",
      args: [treasuryAddress as Hex, parseUnits("10000", 6)],
      account: deployer,
      chain: chainObj,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
  }

  const router = await deploy(ROUTER_ABI, routerArtifact.bytecode as Hex);
  const nft = await deploy(NFT_ABI, nftArtifact.bytecode as Hex);

  // EvilRouter needs its target token + attacker baked in at deploy time.
  const evilHash = await testClient.deployContract({
    abi: EVIL_ABI,
    bytecode: evilArtifact.bytecode as Hex,
    args: [usdc as Hex, attacker as Hex, router],
    account: deployer,
    chain: chainObj,
  });
  const evilRouter = (await publicClient.waitForTransactionReceipt({ hash: evilHash })).contractAddress!;

  // Demo scenario for the "lying contract" attack: the treasury has already
  // approved the (allowlisted-looking) EvilRouter for swaps — the way anyone
  // approves a router before trading. The malice lives in the router's code,
  // which the firewall only sees by simulating. Impersonate the treasury to
  // set that allowance.
  await testClient.writeContract({
    address: usdc as Hex,
    abi: USDC_ABI,
    functionName: "approve",
    args: [evilRouter, maxUint256],
    account: treasuryAddress as Hex,
    chain: chainObj,
  });
  // Give the treasury an NFT so setApprovalForAll has something to endanger.
  await testClient.writeContract({
    address: nft,
    abi: NFT_ABI,
    functionName: "mint",
    args: [treasuryAddress as Hex, 1n],
    account: deployer,
    chain: chainObj,
  });

  setAddress(
    "usdc",
    usdc,
    network === "mainnet" ? "USDC (REAL, Ethereum mainnet)" : "USDC (demo token, deployed on fork)",
  );
  setAddress("router", router, "DemoSwap Router (deployed, allowlisted)");
  setAddress("evilRouter", evilRouter, "DEXMax Router (allowlisted, but malicious)");
  setAddress("nft", nft, "Demo Punks NFT (deployed on fork)");
  setAddress("treasury", treasuryAddress, "Treasury (co-signer wallet)");
  if (opts.attacker) setAddress("attacker", attacker, "Attacker (real drainer, ScamSniffer blocklist)");

  chain = { forked, chain: chainObj, publicClient, testClient };
  bootSnapshot = await testClient.snapshot();
  return chain;
}

export async function usdcBalance(address: string): Promise<bigint> {
  if (!chain) return 0n;
  return (await chain.publicClient.readContract({
    address: registry.usdc as Hex,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [address as Hex],
  })) as bigint;
}

export async function usdcAllowance(owner: string, spender: string): Promise<bigint> {
  if (!chain) return 0n;
  return (await chain.publicClient.readContract({
    address: registry.usdc as Hex,
    abi: USDC_ABI,
    functionName: "allowance",
    args: [owner as Hex, spender as Hex],
  })) as bigint;
}

/** Execute a tx on the live local chain as `from` (auto-impersonated). */
export async function executeAs(from: string, to: string, data: Hex, value: bigint) {
  if (!chain) throw new Error("chain not running");
  const hash = await chain.testClient.sendTransaction({
    account: from as Hex,
    to: to as Hex,
    data,
    value,
    chain: chain.chain,
  });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

export async function snapshot(): Promise<Hex> {
  if (!chain) throw new Error("chain not running");
  return chain.testClient.snapshot();
}

export async function revert(id: Hex): Promise<void> {
  if (!chain) throw new Error("chain not running");
  await chain.testClient.revert({ id });
}

/** Reset the whole demo chain back to its just-bootstrapped state. */
export async function resetChain(): Promise<void> {
  if (!chain || !bootSnapshot) return;
  await chain.testClient.revert({ id: bootSnapshot });
  bootSnapshot = await chain.testClient.snapshot(); // reverts consume snapshots
}

export function stopChain() {
  anvilProcess?.kill();
  anvilProcess = null;
  chain = null;
}
