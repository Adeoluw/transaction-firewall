// Shared types for the Transaction Firewall pipeline.

/** A transaction an agent proposes to sign, plus what it *claims* to do. */
export interface ProposedTx {
  from: string;
  to: string;
  data: string; // 0x-prefixed calldata
  value: string; // wei, decimal string
  chainId: number;
  /** What the requesting agent believes/claims the tx does (untrusted). */
  claimed?: string;
}

export type EffectKind =
  | "approval"
  | "approval_all"
  | "transfer"
  | "swap"
  | "native_transfer"
  | "unknown";

/** One decoded, real effect of the transaction. */
export interface Effect {
  kind: EffectKind;
  /** Human-readable description, e.g. "approve(0xbad..., 2^256-1) on USDC" */
  description: string;
  /** Token contract the effect happens on (the tx `to` for ERC-20 calls). */
  token?: string;
  /** The address that gains something: approval spender or transfer recipient. */
  counterparty?: string;
  /** Raw amount involved (base units), decimal string. */
  amount?: string;
  /** True when an approval is unlimited or near-unlimited. */
  unlimited?: boolean;
  /** Function selector + name when known. */
  functionName?: string;
}

/** Net balance change of the treasury observed across a real simulation. */
export interface BalanceDelta {
  usdc: string; // signed base-units decimal string, e.g. "-10000000000"
  eth: string; // signed wei decimal string
  /** Addresses that received treasury funds during the simulated tx. */
  recipients: string[];
}

export interface SimulationResult {
  effects: Effect[];
  /** Which backend produced the result. */
  backend: "anvil" | "decode";
  /** True if a real simulation ran (vs. static decode). */
  simulated: boolean;
  /** Net treasury balance change — only present for real (anvil) simulation. */
  treasuryDelta?: BalanceDelta;
}

/** Pluggable simulation backend. Tier 2 note: a real fork simulator with
 * balance-diff tracing slots in behind this same interface. */
export interface Simulator {
  available(): Promise<boolean>;
  simulate(tx: ProposedTx): Promise<SimulationResult>;
}

export interface CounterpartyScreen {
  address: string;
  flags: string[]; // e.g. ["threatlist", "fresh_address"]
  /** Mocked address age in days (undefined = unknown, treated as fresh). */
  ageDays?: number;
  threatLabel?: string;
}

export interface Policy {
  id: string;
  name: string;
  /** Addresses allowed to receive approvals/transfers. Lowercase. */
  allowlist: string[];
  noUnlimitedApprovals: boolean;
  /** Max token amount per tx (base units, decimal string). */
  maxValuePerTx: string;
  /** Treasury balance used for the % cap (base units, decimal string). */
  treasuryBalance: string;
  /** Max % of treasury a single tx may move. */
  maxTreasuryPctPerTx: number;
}

export type VerdictLevel = "safe" | "suspicious" | "malicious";

export interface Verdict {
  verdict: VerdictLevel;
  reason: string;
  realEffect: string;
  claimed?: string;
  counterparty?: CounterpartyScreen;
  policyViolations: string[];
  effects: Effect[];
  simulated: boolean;
  backend: "anvil" | "decode";
  policyId: string;
  blocked: boolean;
  /** Net treasury balance change observed during real simulation, if any. */
  treasuryDelta?: BalanceDelta;
}
