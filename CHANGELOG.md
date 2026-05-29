# Changelog

All notable changes to the Jat SDK and services are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Documentation pass to use the Jat brand. The `seal:` link prefix and the on-chain program
  identifiers are part of the deployed wire format and are unchanged.

## [0.4.0] - 2026-06-05

### Added

- `withdraw` in `createSeal`: client-side Merkle path reconstruction, Groth16 proof
  generation, and a relayed withdraw transaction with recipient binding.
- `packages/seal-sdk`: the embeddable TypeScript package with `pay`, `scanOnChain`,
  `claimToAddress`, `claimIntoPool`, and `withdraw`.

## [0.3.0] - 2026-05-10

### Added

- `claimIntoPool`: deposit a matched stealth balance into the shielded pool against a fresh
  precommitment, returning a note to withdraw later.
- Pool client and client-side tree reconstruction (`pool_tree.mjs`).

## [0.2.0] - 2026-04-12

### Added

- Relayer service: fee payment with a program allowlist, a simulation cost cap, a balance
  floor, and per-IP and global rate limits.
- Indexer service: public announcement and pool-leaf endpoints, no scan-key access.

## [0.1.0] - 2026-03-08

### Added

- Stealth core: Ed25519 dual-key derivation, scanning with a one-byte view tag, the
  deterministic message-bound signer, and the payment-link format.
- Devnet end-to-end stealth flow and the wire-format contract test.
