# Security policy

The SDK and the two services sit between the user and the on-chain programs. The most
sensitive parts are the deterministic signer and the relayer.

## Trust model

- **Keys never leave the caller.** Stealth scan and spend keys, and the one-time spend
  scalar, stay in process. The SDK takes them as arguments and never logs or transmits them.
- **The signer is deterministic and message-bound.** `signWithScalar` derives its nonce from
  the scalar and the message, so a fixed message yields a fixed signature and there is no
  per-call randomness to leak the key. Any change to it needs a test that a wrong scalar
  cannot produce a valid signature for the stealth account.
- **The relayer is trusted for liveness only, never for custody or privacy.** It pays fees so
  a fresh account never originates one. It cannot move user funds: the pool pays out of the
  vault PDA, not the relayer.
- **The indexer is untrusted.** It serves only public data (announcements, pool leaves).
  Clients rebuild their own Merkle paths, so it never learns which leaf is yours.

## Hardening to preserve

The relayer refuses any transaction that is not `feePayer = relayer`, references a program
outside the allowlist, references the relayer inside a System instruction, or whose simulated
cost exceeds `MAX_RELAYER_COST_LAMPORTS`, plus a balance floor and per-IP and global rate
limits. A change to `sdk/relayer.mjs` must keep all of these and add a `relay.test.mjs` case.

## Out of scope

- The anonymity-set size (a function of pool liquidity).
- Third-party RPC behavior and availability.

## Reporting

Open a private security advisory on this repository before public disclosure. Include the
component (signer, relayer, indexer, pool client), the flow, and a reproduction if you have
one.
