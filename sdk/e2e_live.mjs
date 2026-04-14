// Full live end-to-end against the DEPLOYED Vercel services, using the published
// seal-sdk: pay -> scan (live indexer) -> claim into pool (live relayer) ->
// withdraw (live indexer + relayer, snarkjs proof). Proves the hosted product.
//   RPC_URL=<helius> LIVE=https://<deployment> SEAL_WALLET=./deploy-wallet.json node sdk/e2e_live.mjs
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import { createSeal, generateMetaAddress } from "../packages/seal-sdk/dist/index.js";

const RPC = process.env.RPC_URL;
const LIVE = process.env.LIVE;
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SEAL_WALLET || "./deploy-wallet.json"))));
const DENOM = 100_000_000;
let ok = 0, fail = 0;
const check = (n, c) => { if (c) { ok++; console.log("  ok:", n); } else { fail++; console.log("  FAIL:", n); } };

const seal = createSeal({
  connection: conn,
  relayerUrl: `${LIVE}/api/relayer`,
  indexerUrl: `${LIVE}/api/indexer`,
  withdrawWasmUrl: "circuits/withdraw_js/withdraw.wasm",
  withdrawZkeyUrl: "circuits/withdraw_final.zkey",
});
// a minimal wallet adapter over the funded keypair
const wallet = {
  publicKey: payer.publicKey,
  sendTransaction: async (tx, c) => { tx.sign(payer); return c.sendRawTransaction(tx.serialize()); },
};

console.log("relayer:", (await fetch(`${LIVE}/api/relayer/health`).then((r) => r.json())).relayer);
const me = generateMetaAddress();

console.log("[1] pay 0.1 SOL to a stealth address + announce...");
const { stealthPk } = await seal.pay(wallet, me.link, DENOM);
console.log("  stealth:", stealthPk.toBase58());

console.log("[2] scan via LIVE indexer (poll for lag)...");
let found = [];
for (let i = 0; i < 15 && found.length === 0; i++) {
  found = await seal.scanOnChain(me.scanKey, me.P_spend);
  if (found.length === 0) await new Promise((r) => setTimeout(r, 2000));
}
check("live indexer scan found the payment", found.some((f) => f.address.equals(stealthPk)));
const match = found.find((f) => f.address.equals(stealthPk));

console.log("[3] claim into pool via LIVE relayer...");
const note = await seal.claimIntoPool(match, me.scanKey, me.spendKey, DENOM);
console.log("  deposit sig:", note.signature);

console.log("[4] withdraw via LIVE indexer + relayer (snarkjs proof)...");
const dest = Keypair.generate().publicKey;
// give the live indexer a moment + bust its 2min cache window is not needed; poll if leaf not indexed
let wr = null;
for (let i = 0; i < 10 && !wr; i++) {
  try { wr = await seal.withdraw(note, DENOM, dest.toBase58()); }
  catch (e) { if (!/no matching/.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 3000)); }
}
console.log("  withdraw sig:", wr?.signature);
check("destination received the denomination", (await conn.getBalance(dest)) === DENOM);

console.log(`\n${ok}/${ok + fail} checks passed`);
console.log(fail === 0 ? "LIVE E2E: PASS" : "LIVE E2E: FAIL");
process.exit(fail === 0 ? 0 : 1);
