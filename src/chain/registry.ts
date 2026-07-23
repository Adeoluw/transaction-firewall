// Runtime address registry. Starts with the static demo addresses from
// config/ and is overwritten by the chain bootstrap once real contracts are
// deployed and the co-signer wallet is loaded.
import addresses from "../../config/addresses.json" with { type: "json" };

export interface AddressRegistry {
  treasury: string;
  attacker: string;
  router: string;
  usdc: string;
  evilRouter: string;
  nft: string;
}

export const registry: AddressRegistry = {
  treasury: addresses.treasury,
  attacker: addresses.attacker,
  router: addresses.router,
  usdc: addresses.usdc,
  evilRouter: addresses.evilRouter,
  nft: addresses.nft,
};

const labels = new Map<string, string>(
  Object.entries(addresses.labels as Record<string, string>),
);

export function setAddress(key: keyof AddressRegistry, addr: string, label: string) {
  registry[key] = addr.toLowerCase();
  labels.set(addr.toLowerCase(), label);
}

export function labelOf(address: string): string | undefined {
  return labels.get(address.toLowerCase());
}
