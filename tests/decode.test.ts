import { describe, expect, it } from "vitest";
import { encodeFunctionData, maxUint256, parseAbi, parseUnits } from "viem";
import { decodeEffects } from "../src/firewall/decode.js";
import addresses from "../config/addresses.json" with { type: "json" };

const abi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
]);

const { treasury, attacker, router, usdc } = addresses;
const base = { from: treasury, to: usdc, value: "0", chainId: 31337 };

describe("decodeEffects", () => {
  it("detects an unlimited approval hidden in calldata", () => {
    const data = encodeFunctionData({
      abi,
      functionName: "approve",
      args: [attacker as `0x${string}`, maxUint256],
    });
    const effects = decodeEffects({ ...base, data });
    expect(effects).toHaveLength(1);
    expect(effects[0].kind).toBe("approval");
    expect(effects[0].unlimited).toBe(true);
    expect(effects[0].counterparty).toBe(attacker);
    expect(effects[0].description).toContain("UNLIMITED");
  });

  it("flags near-unlimited approvals too", () => {
    const data = encodeFunctionData({
      abi,
      functionName: "approve",
      args: [attacker as `0x${string}`, maxUint256 - 1n],
    });
    expect(decodeEffects({ ...base, data })[0].unlimited).toBe(true);
  });

  it("does not flag a bounded approval as unlimited", () => {
    const data = encodeFunctionData({
      abi,
      functionName: "approve",
      args: [router as `0x${string}`, parseUnits("100", 6)],
    });
    const [effect] = decodeEffects({ ...base, data });
    expect(effect.unlimited).toBe(false);
    expect(effect.counterparty).toBe(router);
  });

  it("decodes transfers with recipient and amount", () => {
    const data = encodeFunctionData({
      abi,
      functionName: "transfer",
      args: [router as `0x${string}`, parseUnits("900", 6)],
    });
    const [effect] = decodeEffects({ ...base, data });
    expect(effect.kind).toBe("transfer");
    expect(effect.amount).toBe(parseUnits("900", 6).toString());
  });

  it("reports unknown selectors instead of throwing", () => {
    const [effect] = decodeEffects({ ...base, data: "0xdeadbeef" });
    expect(effect.kind).toBe("unknown");
    expect(effect.description).toContain("0xdeadbeef");
  });
});
