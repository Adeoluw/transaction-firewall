// Regenerates seed/payloads.json — the committed offline-mode demo bytes.
// (When the live chain is up the server re-encodes these same samples against
// the actually-deployed contract addresses.)
// Run with: npm run seed
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import addresses from "../config/addresses.json" with { type: "json" };
import { buildSamples } from "../src/seedgen.js";

const { treasury, attacker, router, usdc, evilRouter, nft } = addresses;
const samples = buildSamples({ treasury, attacker, router, usdc, evilRouter, nft });

const out = {
  generatedBy: "npm run seed",
  addresses: { treasury, attacker, router, usdc, evilRouter, nft },
  samples,
};

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "seed", "payloads.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${samples.length} samples to ${path}`);
for (const s of samples) console.log(`  ${s.id}: ${s.tx.data.slice(0, 34)}…`);
