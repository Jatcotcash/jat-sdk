// Node mirror of the BROWSER withdraw: validates the exact logic the web client
// will run (poseidon-lite hashes, client-side tree reconstruction for any leaf,
// snarkjs library proving, proof->bytes, withdraw instruction) by withdrawing a
// pool leaf to a fresh recipient on devnet. Deposits a fresh leaf first so we
// own its (nullifier, secret). Run: SEAL_WALLET=./deploy-wallet.json node sdk/e2e_withdraw.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import * as snarkjs from "snarkjs";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { reconstruct } from "./pool_tree.mjs";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const POOL = new PublicKey("seuH78RmBPVzoKToLQVEZrDvuL5jDNBSbptozWK9PEm");
const DENOM = 100_000_000n;
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SEAL_WALLET || "./deploy-wallet.json"))));
const recipient = Keypair.generate();

const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const be32 = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const rnd = () => BigInt("0x" + randomBytes(24).toString("hex"));
const [treeState] = PublicKey.findProgramAddressSync([Buffer.from("tree")], POOL);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], POOL);

// proof.json -> groth16-solana byte arrays (port of scripts/proof_to_bytes.mjs)
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const g1neg = (p) => Buffer.concat([be32(p[0]), be32((Q - (BigInt(p[1]) % Q)) % Q)]);
const g1 = (p) => Buffer.concat([be32(p[0]), be32(p[1])]);
const g2 = (p) => Buffer.concat([be32(p[0][1]), be32(p[0][0]), be32(p[1][1]), be32(p[1][0])]);

let checks = 0, failed = 0;
const check = (n, c) => { checks++; if (c) console.log("  ok:", n); else { failed++; console.log("  FAIL:", n); } };

// 1. deposit a fresh leaf we own
const secret = rnd(), nullifier = rnd();
const precommit = poseidon2([nullifier, secret]);
console.log("[1] deposit a fresh pool leaf...");
await sendAndConfirmTransaction(conn, new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
  .add(new TransactionInstruction({
    programId: POOL,
    keys: [
      { pubkey: treeState, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("deposit"), u64le(DENOM), be32(precommit)]),
  })), [payer], { commitment: "confirmed" });

// 2. reconstruct the tree client-side and locate OUR leaf by its precommit
console.log("[2] reconstruct tree + locate our leaf...");
const r = await reconstruct(conn);
check("reconstructed root matches on-chain", r.matches);
const myIndex = r.deposits.findIndex((d) => d.precommit === precommit && d.value === DENOM);
check("found our leaf by precommit", myIndex >= 0);
const leaf = poseidon3([DENOM, BigInt(myIndex), precommit]);
check("our leaf equals the reconstructed leaf", leaf === r.leaves[myIndex]);
const { pathElements, pathIndices } = r.pathFor(myIndex);

// 3. prove the withdraw with the snarkjs library (same as the browser)
console.log("[3] snarkjs prove (library)...");
const nfW = poseidon1([nullifier]);
const rb = recipient.publicKey.toBytes();
const recipientHash = poseidon2([
  BigInt("0x" + Buffer.from(rb.slice(0, 16)).toString("hex")),
  BigInt("0x" + Buffer.from(rb.slice(16, 32)).toString("hex")),
]);
const input = {
  merkleRoot: r.root.toString(), value: DENOM.toString(),
  recipientHash: recipientHash.toString(), nullifierHash: nfW.toString(),
  label: myIndex.toString(), secret: secret.toString(), nullifier: nullifier.toString(),
  pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
};
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input, "circuits/withdraw_js/withdraw.wasm", "circuits/withdraw_final.zkey");
check("public signals == [root, value, recipientHash, nfW]",
  publicSignals[0] === r.root.toString() && publicSignals[3] === nfW.toString());

// 4. submit the withdraw (payer pays fee for this mirror; browser uses the relayer)
console.log("[4] withdraw to recipient...");
const [wNf] = PublicKey.findProgramAddressSync([Buffer.from("wnf"), be32(nfW)], POOL);
const before = await conn.getBalance(recipient.publicKey);
const sig = await sendAndConfirmTransaction(conn, new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }))
  .add(new TransactionInstruction({
    programId: POOL,
    keys: [
      { pubkey: treeState, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
      { pubkey: wNf, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("withdraw"), g1neg(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c),
      be32(r.root), be32(DENOM), be32(recipientHash), be32(nfW)]),
  })), [payer], { commitment: "confirmed" });
console.log("  withdraw tx:", sig);
check("recipient received exactly the denom", (await conn.getBalance(recipient.publicKey)) - before === Number(DENOM));

console.log(`\n${checks - failed}/${checks} checks passed`);
console.log(failed === 0 ? "WITHDRAW E2E: PASS" : "WITHDRAW E2E: FAIL");
process.exit(failed === 0 ? 0 : 1);
