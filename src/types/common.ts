/** 20-byte account or contract address. Stored lowercase. */
export type Address = `0x${string}`;

/** Arbitrary hex payload, including empty calldata `0x`. */
export type Hex = `0x${string}`;

export type Clock = () => number;

export function systemClock(): number {
  return Date.now();
}

export function toIsoTimestamp(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isHex(value: string): value is Hex {
  return /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0;
}

export function normalizeAddress(value: Address): Address {
  return value.toLowerCase() as Address;
}

export function normalizeHex(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

/**
 * Confirmation counts fit in a safe integer. Wei amounts must stay `bigint`.
 */
export function confirmationCount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`confirmation count ${value} is outside the safe integer range`);
  }
  return Number(value);
}
