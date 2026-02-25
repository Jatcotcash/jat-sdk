// End-to-end devnet check of the SDK's PRODUCTION signer (deterministic Fix-B
// nonce), exercising the full public API: generate -> link -> payerDerive ->
// fund -> scan -> spendScalar -> signWithScalar -> sweep. Proves the production
// path (not just the earlier random-nonce spike) lands a real stealth spend.
// Run: SEAL_WALLET=./deploy-wallet.json node sdk/devnet_check.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import fs from "node:fs";
import {
  generateMetaAddress, parseLink, payerDerive, scan, spendScalar, signWithScalar,
} from "./stealth.mjs";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SEAL_WALLET || "./deploy-wallet.json"))));

// recipient side: a meta-address + a payment link they publish.
const meta = generateMetaAddress();
console.log("payment link:", meta.link);

// payer side: parse the link, derive a one-time stealth address to fund.
const { P_stealth, R, viewTag } = payerDerive(parseLink(meta.link));
const stealthPk = new PublicKey(P_stealth);
console.log("derived stealth address:", stealthPk.toBase58(), "view tag:", viewTag);

// recipient side (scan-only): find the payment from announcement {R, viewTag}.
const mine = scan([{ R, viewTag }], meta.scanKey, meta.P_spend);
if (mine.length !== 1 || !Buffer.from(mine[0].P_stealth).equals(Buffer.from(P_stealth)))
  throw new Error("scan failed to match the derived address");
console.log("recipient scan matched the announcement");

// 1. payer funds the stealth address
console.log("[1] funding stealth address...");
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({
  fromPubkey: payer.publicKey, toPubkey: stealthPk, lamports: 3_000_000 })), [payer], { commitment: "confirmed" });
const bal = await conn.getBalance(stealthPk);
console.log("  stealth balance:", bal);

// 2. recipient computes the one-time spend scalar and sweeps with the SDK signer
console.log("[2] sweeping FROM stealth (deterministic Fix-B signature)...");
const p_stealth = spendScalar(R, meta.scanKey, meta.spendKey);
const tx = new Transaction().add(SystemProgram.transfer({
  fromPubkey: stealthPk, toPubkey: payer.publicKey, lamports: bal - 5000 }));
tx.feePayer = stealthPk;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
const msgBytes = tx.serializeMessage();
const sig = signWithScalar(p_stealth, P_stealth, msgBytes);
console.log("  local verify_strict of tx sig:", ed25519.verify(sig, msgBytes, P_stealth));
tx.addSignature(stealthPk, Buffer.from(sig));
const txid = await sendAndConfirmRawTransaction(conn, tx.serialize(), { commitment: "confirmed" });
console.log("  STEALTH SWEEP landed:", txid);
console.log("\nSDK DEVNET CHECK: PASS - production deterministic signer accepted on-chain");
