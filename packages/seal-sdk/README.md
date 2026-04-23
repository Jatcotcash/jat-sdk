# seal-sdk

Drop-in stealth payments and a shielded pool for Solana apps. Two privacy axes,
composable:

- **Graph privacy** (stealth addresses): a payer sends to a one-time address
  derived from the recipient's published link. No on-chain link between them.
- **Value privacy** (shielded pool): the recipient deposits into a pool and later
  withdraws to a fresh address with a zero-knowledge proof. The amount is unlinked.

Fees can be paid by a relayer, so a recipient never needs a funded wallet.
Isomorphic: runs in the browser and in Node.

> Status: devnet. The Groth16 trusted setup is a single-party dev ceremony and the
> code is unaudited. Do not use with real funds until a real multi-party ceremony
> and an audit are done. Value privacy is only as strong as the pool's anonymity
> set (the number of same-denomination deposits).

## Install

```
npm i seal-sdk @solana/web3.js
```

## Configure

Everything is injected, nothing is read from the environment:

```ts
import { Connection } from "@solana/web3.js";
import { createSeal } from "seal-sdk";

const seal = createSeal({
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  relayerUrl: "https://your-relayer",   // pays recipient fees (run sdk/relayer from the SEAL repo)
  indexerUrl: "https://your-indexer",   // serves announcements + pool leaves
  withdrawWasmUrl: "/circuits/withdraw.wasm",        // host these two static files
  withdrawZkeyUrl: "/circuits/withdraw_final.zkey",
});
```

## Receive: publish a link

```ts
import { generateMetaAddress } from "seal-sdk";
const me = generateMetaAddress();
// me.link     -> show as text/QR. me.scanKey / me.spendKey -> the recipient keeps.
```

## Pay: fund + announce (one tx)

```ts
// wallet is any @solana/wallet-adapter wallet ({ publicKey, sendTransaction })
const { stealthPk, txid } = await seal.pay(wallet, link, 0.05 * 1e9);
```

## Claim: to an address, or into the pool

```ts
const found = await seal.scanOnChain(me.scanKey, me.P_spend);   // [{ address, lamports, R, P_stealth }]

// (a) graph privacy only, relayer pays the fee:
await seal.claimToAddress(found[0], me.scanKey, me.spendKey, myDestination, found[0].lamports);

// (b) full privacy: deposit into the pool, keep the note to withdraw later:
const note = await seal.claimIntoPool(found[0], me.scanKey, me.spendKey, found[0].lamports);
// SAVE note.nullifier + note.secret. They are the only way to withdraw.
```

## Withdraw: pool -> fresh address (ZK proof in-process)

```ts
const { signature } = await seal.withdraw(
  { nullifier: note.nullifier, secret: note.secret },
  100_000_000,   // the denomination you deposited
  freshAddress,
);
```

Denominations (`DENOMS`): 5_000, 50_000_000, 100_000_000, 1_000_000_000 lamports.
Only same-denom deposits are mutually anonymous.

## API

- `generateMetaAddress()`, `parseLink`, `payerDerive`, `scan`, `spendScalar`,
  `signWithScalar`, `pubFromSecretHex`: the pure stealth crypto (no network).
- `createSeal(config)` -> `{ pay, scanOnChain, claimToAddress, claimIntoPool, withdraw, fetchAnnouncements, announcementPda, programs }`.

## Services

The relayer and indexer are small Node services in the SEAL repo (`sdk/relayer.mjs`,
`sdk/indexer.mjs`). Run your own or point at a shared deployment. The indexer only
serves public data; the relayer only pays gas (it refuses to be the source of a
transfer). The withdraw circuit artifacts (`withdraw.wasm`, `withdraw_final.zkey`)
are static files you host.
