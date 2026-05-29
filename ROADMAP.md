# Roadmap

## Shipped

- [x] Ed25519 dual-key stealth derivation and the payment-link format
- [x] Scanning with a one-byte view-tag prefilter
- [x] Deterministic, message-bound signer for one-time spend scalars
- [x] Wire-format contract test pinned against the program IDL
- [x] Relayer service: program allowlist, simulation cost cap, balance floor, rate limits
- [x] Indexer service: public announcements and pool leaves, no scan-key access
- [x] Pool client and client-side Merkle path reconstruction
- [x] `claimIntoPool` for value privacy
- [x] `withdraw` with client-side proof generation and recipient binding
- [x] Embeddable TypeScript package `seal-sdk` (`createSeal`)
- [x] Docker setup for the relayer and indexer
- [x] Devnet end-to-end flows for stealth, pool, and withdraw
