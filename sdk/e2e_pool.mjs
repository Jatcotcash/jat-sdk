// Full-privacy claim, devnet: a stealth payment is claimed by depositing it into
// the SEAL pool (value privacy) instead of sweeping to a plain address. The
// stealth account is the depositor and signs with its raw scalar; the relayer
// pays the fee. The recipient saves (nullifier, secret) to withdraw from the
// pool later, value-privately. Composes graph privacy (stealth) + value privacy
// (pool). Requires the relayer running (node sdk/relayer.mjs).
//   SEAL_WALLET=./deploy-wallet.json node sdk/e2e_pool.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { buildPoseidon } from "circomlibjs";
import { generateMetaAddress } from "./stealth.mjs";
import { pay, scanOnChain } from "./client.mjs";
import { spendScalar, signWithScalar } from "./stealth.mjs";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const RELAYER = process.env.RELAYER_URL || "http://127.0.0.1:8789";
const POOL = new PublicKey("seuH78RmBPVzoKToLQVEZrDvuL5jDNBSbptozWK9PEm");
const DENOM = 100_000_000n; // 0.1 SOL, a valid pool denomination
const DEPTH = 20;
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SEAL_WALLET || "./deploy-wallet.json"))));

const poseidon = await buildPoseidon();
const F = poseidon.F;
const H = (...xs) => F.toObject(poseidon(xs));
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const be32 = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const rnd = () => BigInt("0x" + randomBytes(24).toString("hex"));
const [treeState] = PublicKey.findProgramAddressSync([Buffer.from("tree")], POOL);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], POOL);
const treeN = (data) => Number(data.subarray(8).readBigUInt64LE(32)); // next_leaf_index
let checks = 0, failed = 0;
const check = (n, c) => { checks++; if (c) console.log("  ok:", n); else { failed++; console.log("  FAIL:", n); } };

const relayer = new PublicKey((await fetch(`${RELAYER}/health`).then((r) => r.json())).relayer);
console.log("relayer:", relayer.toBase58());

// 0. ensure the pool tree exists
let ai = await conn.getAccountInfo(treeState);
if (!ai) {
  console.log("[0] init_tree...");
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: POOL,
    keys: [
      { pubkey: treeState, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("init_tree"),
  })), [payer], { commitment: "confirmed" });
  ai = await conn.getAccountInfo(treeState);
}
const leavesBefore = treeN(ai.data);
console.log("pool leaves before:", leavesBefore);

// 1. a payer pays a pool-denomination amount to a stealth address
const meta = generateMetaAddress();
console.log("[1] pay one denomination to a stealth address + announce...");
const { stealthPk } = await pay(conn, payer, meta.link, Number(DENOM));
console.log("  stealth:", stealthPk.toBase58(), "balance", await conn.getBalance(stealthPk));

// 2. recipient finds it
console.log("[2] scan (polling)...");
let match;
for (let i = 0; i < 15 && !match; i++) {
  [match] = await scanOnChain(conn, meta.scanKey, meta.P_spend);
  if (!match) await new Promise((r) => setTimeout(r, 2000));
}
check("scan found the payment", !!match && new PublicKey(match.P_stealth).equals(stealthPk));

// 3. recipient claims it INTO the pool: stealth account is the depositor (raw-scalar
//    signed), relayer pays the fee. Recipient keeps (nullifier, secret) to withdraw.
console.log("[3] deposit stealth funds into the pool (relayer pays fee)...");
const secret = rnd(), nullifier = rnd();
const precommit = H(nullifier, secret);
const depositIx = new TransactionInstruction({
  programId: POOL,
  keys: [
    { pubkey: treeState, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: stealthPk, isSigner: true, isWritable: true }, // depositor = stealth account
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc("deposit"), u64le(DENOM), be32(precommit)]),
});
const tx = new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
  .add(depositIx);
tx.feePayer = relayer;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
const sig = signWithScalar(spendScalar(match.R, meta.scanKey, meta.spendKey), match.P_stealth, tx.serializeMessage());
tx.addSignature(stealthPk, Buffer.from(sig));
const out = await fetch(`${RELAYER}/relay`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false }).toString("base64") }),
}).then((r) => r.json());
if (out.error) throw new Error("relayer rejected: " + out.error);
console.log("  deposit tx:", out.signature);

// 4. verify the pool grew by one leaf and the stealth funds left the account
const post = await conn.getAccountInfo(treeState);
check("pool tree grew by exactly one leaf", treeN(post.data) === leavesBefore + 1);
check("stealth funds moved into the pool", (await conn.getBalance(stealthPk)) === 0);

console.log(`\n${checks - failed}/${checks} checks passed`);
console.log("  saved for withdraw -> nullifier:", nullifier.toString(), "secret:", secret.toString());
console.log(failed === 0 ? "POOL CLAIM E2E: PASS" : "POOL CLAIM E2E: FAIL");
process.exit(failed === 0 ? 0 : 1);
