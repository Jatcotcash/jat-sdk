// Live devnet test of the RELAYER claim path: a recipient claims a stealth
// payment without the zero-history stealth account paying its own fee. Requires
// the relayer service running (node sdk/relayer.mjs). Run:
//   RELAYER_WALLET=./deploy-wallet.json RPC_URL=... node sdk/relayer.mjs   (in one shell)
//   SEAL_WALLET=./deploy-wallet.json RPC_URL=... node sdk/e2e_relayer.mjs  (in another)
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import { generateMetaAddress } from "./stealth.mjs";
import { pay, scanOnChain, buildRelayedTransfer } from "./client.mjs";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const RELAYER = process.env.RELAYER_URL || "http://127.0.0.1:8789";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SEAL_WALLET || "./deploy-wallet.json"))));
const AMOUNT = 3_000_000;
let checks = 0, failed = 0;
const check = (n, c) => { checks++; if (c) console.log("  ok:", n); else { failed++; console.log("  FAIL:", n); } };

const relayer = new PublicKey((await fetch(`${RELAYER}/health`).then((r) => r.json())).relayer);
console.log("relayer:", relayer.toBase58());

const meta = generateMetaAddress();
console.log("[1] pay (fund stealth + announce)...");
const { stealthPk } = await pay(conn, payer, meta.link, AMOUNT);
console.log("  stealth:", stealthPk.toBase58());

console.log("[2] scan (polling, getProgramAccounts index lags confirmation)...");
let match;
for (let i = 0; i < 15 && !match; i++) {
  [match] = await scanOnChain(conn, meta.scanKey, meta.P_spend);
  if (!match) await new Promise((r) => setTimeout(r, 2000));
}
check("scan found the payment", !!match && new PublicKey(match.P_stealth).equals(stealthPk));
if (!match) { console.log("RELAYER E2E: FAIL (scan)"); process.exit(1); }

console.log("[3] claim via relayer (relayer pays the fee)...");
const dest = Keypair.generate().publicKey; // fresh destination
const relayerBalBefore = await conn.getBalance(relayer);
// relayer pays the fee, so the FULL stealth balance can move
const lamports = await conn.getBalance(stealthPk);
const tx = await buildRelayedTransfer(conn, match, meta.scanKey, meta.spendKey, dest, lamports, relayer);
const out = await fetch(`${RELAYER}/relay`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx }),
}).then((r) => r.json());
if (out.error) throw new Error("relayer rejected: " + out.error);
console.log("  relay tx:", out.signature);

check("destination received the full amount", (await conn.getBalance(dest)) === lamports);
check("stealth account fully drained", (await conn.getBalance(stealthPk)) === 0);
check("relayer paid the fee (its balance dropped)", (await conn.getBalance(relayer)) < relayerBalBefore);

console.log(`\n${checks - failed}/${checks} checks passed`);
console.log(failed === 0 ? "RELAYER E2E: PASS" : "RELAYER E2E: FAIL");
process.exit(failed === 0 ? 0 : 1);
