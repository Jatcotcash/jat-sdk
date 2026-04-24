// seal-sdk: stealth payments + shielded-pool client for Solana.
//
//   import { createSeal, generateMetaAddress } from "seal-sdk";
//
// Recipient publishes generateMetaAddress().link; payers derive a one-time
// address from it (graph privacy); recipients claim to an address or into the
// pool and later withdraw with a ZK proof (value privacy). All fees can be paid
// by a relayer so recipients need no funded wallet. See README for a full flow.
export {
  generateMetaAddress,
  parseLink,
  payerDerive,
  scan,
  spendScalar,
  signWithScalar,
  pubFromSecretHex,
  toHex,
  fromHex,
} from "./stealth.js";
export type { MetaAddress, Announcement, StealthMatch } from "./stealth.js";

export {
  createSeal,
  DEFAULTS,
  DENOMS,
  isDenom,
} from "./seal.js";
export type { SealConfig, WalletLike, PoolNote } from "./seal.js";
