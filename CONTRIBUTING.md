# Contributing to jat-sdk

This is the layer apps use: stealth key derivation and scanning, the deterministic signer,
the pool client, and the relayer and indexer services. The on-chain programs are in
`jat-program` and the circuits in `jat-circuits`, so a wire-format change usually starts
there.

## Two surfaces

- `sdk/` is the reference implementation in isomorphic JavaScript, plus the two services.
- `packages/seal-sdk/` is the embeddable TypeScript package (`createSeal(config)`).

Keep them in step. If you change the wire format (instruction layout, discriminator, public
inputs), update both, and update `jat-program`'s host test and the circuits to match.

## Building and testing

```bash
npm install
npm test                          # stealth, contract wire-format, relayer rejection tests
npm run build:pkg                 # tsc for packages/seal-sdk

# end to end against devnet (needs a funded keypair and an RPC)
RPC_URL=https://api.devnet.solana.com node sdk/e2e_stealth.mjs
```

`sdk/contract.test.mjs` asserts the client's discriminators and account sizes against the
same IDL values `jat-program` pins from its side. If it fails, the client and the program
have drifted.

## The services

- The **relayer** must stay un-drainable. Any change to `sdk/relayer.mjs` must keep the
  program allowlist, the no-relayer-in-a-System-instruction rule, the simulation cost cap,
  the balance floor, and the rate limits. Add a test to `sdk/relay.test.mjs` for any new
  acceptance or rejection path.
- The **indexer** serves only public data. Do not add an endpoint that returns anything
  derived from a scan key or that links a leaf to a recipient.

## Secrets

Never commit a relayer or deployer wallet, a keypair, or a `.env`. The `.gitignore` blocks
the common shapes; extend it in the same commit if you add a new one. Use `.env.example` for
references, never real values.

## Style

- `npx prettier --write` before pushing. CI runs `prettier --check` and `tsc --noEmit`.
- Short, domain-dense comments. Explain the privacy property a line preserves.

See the PR template before opening a pull request.
