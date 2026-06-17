# jat-sdk

<p>
  <a href="https://github.com/Jatcotcash/jat-sdk/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-4f7799?style=flat-square" alt="license"/>
  </a>
  <a href="https://github.com/Jatcotcash/jat-sdk/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/Jatcotcash/jat-sdk/ci.yml?branch=main&style=flat-square&label=ci" alt="ci"/>
  </a>
  <img src="https://img.shields.io/badge/typescript-5.7-7aa874?style=flat-square" alt="typescript"/>
  <img src="https://img.shields.io/badge/runtime-node%20%2B%20browser-d8a657?style=flat-square" alt="isomorphic"/>
  <img src="https://img.shields.io/badge/solana-devnet-b8473f?style=flat-square" alt="solana devnet"/>
  <a href="https://github.com/Jatcotcash/jat-sdk/commits/main">
    <img src="https://img.shields.io/github/last-commit/Jatcotcash/jat-sdk?style=flat-square&color=4f7799" alt="last commit"/>
  </a>
</p>

Client SDK and services for **Jat**, private payments on Solana. This is the layer apps use:
key derivation, scanning, paying, claiming, and withdrawing, plus the two small services
that back the flows. The on-chain programs are in `jat-program`; the circuits in
`jat-circuits`.

## Two privacy axes

| Axis | What it hides | How |
| --- | --- | --- |
| Graph privacy | the payer to recipient link | Ed25519 dual-key stealth addresses, ECDH, one-time address per payment |
| Value privacy | the amount | fixed-denomination shielded pool, Groth16 withdraw to a fresh address |

They compose: pay to a stealth address, claim into the pool, withdraw later to a fresh
address. All fees can be paid by a relayer, so a recipient needs no funded wallet.

## What is here

- `sdk/`: the reference implementation in isomorphic JavaScript. Stealth key derivation and
  scanning, the deterministic signer, the pool client, the relayer and indexer services, and
  end-to-end tests against devnet.
- `packages/seal-sdk/`: the embeddable TypeScript package. `createSeal(config)` gives you
  `pay`, `scanOnChain`, `claimToAddress`, `claimIntoPool`, and `withdraw`, plus the pure key
  helpers.
- `ops/`: Docker setup to host the relayer and indexer.

## Quick start

```ts
import { createSeal, generateMetaAddress } from "seal-sdk";
import { Connection } from "@solana/web3.js";

// recipient: publish a payment link
const meta = generateMetaAddress();
// meta.link -> "seal:pay:..."  (share it; keep spendKey + scanKey secret)

const seal = createSeal({
  connection: new Connection("https://api.devnet.solana.com"),
  relayerUrl: "https://relayer.example",
  indexerUrl: "https://indexer.example",
});

// payer: fund a one-time address and announce, in one tx
await seal.pay(wallet, meta.link, 100_000_000);
// -> { stealthPk: PublicKey, txid: string }

// recipient: find what is yours, then claim into the pool for value privacy
const mine = await seal.scanOnChain(meta.scanKey, meta.P_spend);
const note = await seal.claimIntoPool(mine[0], meta.scanKey, meta.spendKey, 100_000_000);
// -> { signature, nullifier, secret }   (keep the note to withdraw later)
```

## The two services

- **Relayer** pays the network fee so a fresh address never originates one. It is hardened to
  only ever pay gas: it rejects any transaction that references it inside a System
  instruction, that exceeds a simulated cost cap, or that would push it below a balance
  floor, and it rate limits per client.
- **Indexer** serves public data only, announcements and pool leaves. Clients rebuild their
  own Merkle paths, so it never learns which payment or leaf is yours.

Neither service ever holds a spend key or custodies funds.

## Run locally

```bash
git clone https://github.com/Jatcotcash/jat-sdk
cd gee
npm install

RELAYER_WALLET=./relayer.json RPC_URL=https://api.devnet.solana.com node sdk/relayer.mjs  # :8789
RPC_URL=https://api.devnet.solana.com node sdk/indexer.mjs                                # :8788
```

The relayer wallet is a secret. It is mounted as a Docker secret in `ops/`, never committed.
See `.env.example` for the full set of variables.

## Project structure

```
gee/
  packages/seal-sdk/
    src/index.ts       public exports
    src/stealth.ts     Ed25519 dual-key derivation, scan, deterministic signer
    src/seal.ts        createSeal: pay, scanOnChain, claimToAddress, claimIntoPool, withdraw
  sdk/
    stealth.mjs        reference stealth core
    relayer.mjs        fee relayer (allowlist, cost cap, rate limits)
    indexer.mjs        public announcement + pool-leaf endpoints
    pool_tree.mjs      client-side tree reconstruction
    e2e_*.mjs          devnet end-to-end flows
    *.test.mjs         stealth, wire-format, relayer rejection tests
  ops/                 Dockerfile + compose for the services
```

## Status

Runs on devnet. No third-party audit yet. Do not use with real funds.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT, see [LICENSE](LICENSE).

## Links

- On-chain programs: https://github.com/Jatcotcash/jat-program
- Circuits: https://github.com/Jatcotcash/jat-circuits
