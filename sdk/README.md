# SEAL stealth SDK

Embeddable stealth-payment primitives for Solana: a payer funds a one-time
address derived from a recipient's published meta-address, with no on-chain link
between them. Pure ECDH key derivation (no ZK), so it is light and composes with
the SEAL pool for value privacy. Read `../DESIGN_stealth.md` for the scheme,
the signer, and the honest threat model before shipping anything user-facing.

## Modules

| file | role |
|---|---|
| `stealth.mjs` | crypto core: `generateMetaAddress`, `parseLink`, `payerDerive`, `scan`, `spendScalar`, `signWithScalar`, `verify` |
| `client.mjs` | Solana glue: `pay`, `scanOnChain`, `sweep`, `buildRelayedTransfer`, `announcementPda` |
| `indexer.mjs` | untrusted HTTP scan service (serves raw announcements; never sees a scan key) |
| `relayer.mjs` | HTTP fee relayer (pays the stealth account's first fee; never custodies funds) |

## Recipient: publish a link

```js
import { generateMetaAddress } from "./stealth.mjs";
const me = generateMetaAddress();
// me.link   -> share this (a "seal:pay:<base64url>" string or QR)
// me.scanKey  -> may be handed to an untrusted indexer to watch for you
// me.spendKey -> SECRET, keep offline; it controls the funds
```

## Payer: fund + announce (one transaction)

```js
import { Connection, Keypair } from "@solana/web3.js";
import { pay } from "./client.mjs";
const conn = new Connection(process.env.RPC_URL);
const { stealthPk, txid } = await pay(conn, payerKeypair, link, 2_000_000);
// transfers to the derived stealth address AND writes the announcement atomically
```

## Recipient: scan + claim

```js
import { scanOnChain, buildRelayedTransfer } from "./client.mjs";
const matches = await scanOnChain(conn, me.scanKey, me.P_spend); // view-tag prefiltered
// claim WITHOUT paying a fee from the zero-history stealth account:
const tx = await buildRelayedTransfer(conn, matches[0], me.scanKey, me.spendKey, dest, amount, relayerPubkey);
const { signature } = await fetch(`${RELAYER}/relay`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx }),
}).then((r) => r.json());
```

`sweep` (stealth account pays its own fee) also exists, but the relayer path is
the default: a fresh stealth account paying its own first fee is the main way a
recipient gets deanonymized. For full privacy, relay into a SEAL pool deposit
rather than to a plain address, so the amount is hidden too.

## Services

```
RPC_URL=https://api.devnet.solana.com node sdk/indexer.mjs   # :8788  GET /announcements?since=<slot>
RELAYER_WALLET=./relayer.json RPC_URL=... node sdk/relayer.mjs # :8789  POST /relay { tx }
```

Both are deliberately trust-minimal: the indexer only sees public data, and the
relayer refuses any transaction that references its own key inside an instruction
or touches a program outside `{ System, SEAL pool, SEAL announcer }`, so it can
pay gas and nothing else.

## Tests

```
npm run test:stealth    # crypto core, 550 assertions (derivation, ECDH, clamp trap, deterministic nonce)
npm run test:contract   # client wire format == Anchor IDL
npm run test:relay       # relayed-transfer builder (fee owed by relayer, stealth sig valid)
```

## Live devnet end-to-end

The announcer is deployed on devnet (`seaWHA64tVzN8yfa33bE6cvqKRSxVp3R6c7Ts5NXPM9`).
Both flows pass against it:

```
SEAL_WALLET=./deploy-wallet.json node sdk/e2e_stealth.mjs   # pay+announce -> scan -> sweep (6/6)

# relayer path (recipient pays no fee): run the relayer, then the e2e
RELAYER_WALLET=./deploy-wallet.json node sdk/relayer.mjs &
node sdk/e2e_relayer.mjs                                    # pay -> scan -> relayed claim (4/4)

# full privacy (graph + value): claim a stealth payment INTO the pool, then withdraw
node sdk/e2e_pool.mjs        # stealth -> pool deposit via relayer (3/3)
node sdk/e2e_withdraw.mjs    # rebuild path -> snarkjs prove -> withdraw to fresh addr (5/5)
node sdk/pool_tree.mjs       # sanity: reconstructed Merkle root == on-chain root
```

The website mirrors all of this (`web/`): `/receive`, `/pay`, `/claim` (to an
address or into the pool), and `/withdraw` (in-browser snarkjs proof, client-side
Merkle path, relayer-paid payout). The browser uses `poseidon-lite` (byte-identical
to the circuit's Poseidon) and serves `withdraw.wasm` + `withdraw_final.zkey` from
`/public/circuits`.

Note: `getProgramAccounts` (the scan) is index-lagged behind transaction
confirmation on public RPC, so a scan immediately after a payment may need a
short retry; the e2e polls for this.
