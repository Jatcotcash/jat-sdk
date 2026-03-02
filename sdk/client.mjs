// SEAL stealth client: ties the crypto core (stealth.mjs) to Solana. Builds the
// atomic payer transaction (fund the derived stealth address + announce R in one
// tx), enumerates announcements the way an untrusted indexer would, and sweeps a
// received payment with the raw-scalar signer. No Anchor TS runtime needed: the
// announce instruction is assembled from its discriminator + borsh args directly.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { parseLink, payerDerive, scan, spendScalar, signWithScalar } from "./stealth.mjs";

export const ANNOUNCER_PROGRAM_ID = new PublicKey("seaWHA64tVzN8yfa33bE6cvqKRSxVp3R6c7Ts5NXPM9");
const ANN_ACCOUNT_SIZE = 8 + 32 + 1 + 1 + 8; // discriminator + R + view_tag + scheme + slot
const SCHEME_ED25519 = 0;

// Anchor instruction discriminator: first 8 bytes of sha256("global:<name>").
const discriminator = (name) => sha256(new TextEncoder().encode("global:" + name)).slice(0, 8);

export function announcementPda(R) {
  return PublicKey.findProgramAddressSync([Buffer.from("ann"), Buffer.from(R)], ANNOUNCER_PROGRAM_ID)[0];
}

export function buildAnnounceIx(payerPubkey, R, viewTag, scheme = SCHEME_ED25519) {
  const data = Buffer.concat([
    Buffer.from(discriminator("announce")),
    Buffer.from(R),               // [u8;32], no length prefix
    Buffer.from([viewTag & 0xff]),
    Buffer.from([scheme & 0xff]),
  ]);
  return new TransactionInstruction({
    programId: ANNOUNCER_PROGRAM_ID,
    keys: [
      { pubkey: payerPubkey, isSigner: true, isWritable: true },
      { pubkey: announcementPda(R), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// payer: fund the recipient's one-time stealth address and announce R, atomically.
export async function pay(conn, payerKeypair, link, lamports) {
  const { P_stealth, R, viewTag } = payerDerive(parseLink(link));
  const stealthPk = new PublicKey(P_stealth);
  const tx = new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: payerKeypair.publicKey, toPubkey: stealthPk, lamports }))
    .add(buildAnnounceIx(payerKeypair.publicKey, R, viewTag));
  const txid = await sendAndConfirmTransaction(conn, tx, [payerKeypair], { commitment: "confirmed" });
  return { stealthPk, R, viewTag, txid };
}

// indexer/recipient: pull every announcement, run the view-tag prefilter + match.
// An untrusted indexer can do exactly this with only the scan key (no spend power).
export async function scanOnChain(conn, scanKey, P_spend) {
  const accts = await conn.getProgramAccounts(ANNOUNCER_PROGRAM_ID, {
    filters: [{ dataSize: ANN_ACCOUNT_SIZE }],
  });
  const anns = accts.map(({ account }) => ({
    R: new Uint8Array(account.data.subarray(8, 40)),
    viewTag: account.data[40],
    scheme: account.data[41],
  }));
  return scan(anns, scanKey, P_spend); // [{R, P_stealth, s_h}, ...]
}

// recipient: sweep a received stealth payment to `toPubkey`, signing with the
// derived raw scalar. Leaves `leaveLamports` behind (0 to drain to the fee floor).
export async function sweep(conn, match, scanKey, spendKey, toPubkey, leaveLamports = 0) {
  const stealthPk = new PublicKey(match.P_stealth);
  const bal = await conn.getBalance(stealthPk);
  const FEE = 5000;
  const send = bal - FEE - leaveLamports;
  if (send <= 0) throw new Error("stealth balance below fee floor");
  const p_stealth = spendScalar(match.R, scanKey, spendKey);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: stealthPk, toPubkey, lamports: send }));
  tx.feePayer = stealthPk;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const msg = tx.serializeMessage();
  const sig = signWithScalar(p_stealth, match.P_stealth, msg);
  if (!ed25519.verify(sig, msg, match.P_stealth)) throw new Error("local sig verify failed");
  tx.addSignature(stealthPk, Buffer.from(sig));
  const txid = await sendAndConfirmRawTransaction(conn, tx.serialize(), { commitment: "confirmed" });
  return { txid, swept: send };
}

// Build a transfer FROM a received stealth address whose FEE is paid by a RELAYER
// (feePayer = relayer). A fresh stealth account holds only the received amount and,
// if it paid its own first fee, would leak the recipient through that fee path
// (the threat model's main weakness). Here the relayer pays, so the full amount
// can move and the stealth account never originates a fee. Returns a base64
// transaction signed by the stealth account only; the relayer co-signs + submits.
export async function buildRelayedTransfer(conn, match, scanKey, spendKey, toPubkey, lamports, relayerPubkey) {
  const stealthPk = new PublicKey(match.P_stealth);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: stealthPk, toPubkey: new PublicKey(toPubkey), lamports }));
  tx.feePayer = new PublicKey(relayerPubkey);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const msg = tx.serializeMessage();
  const sig = signWithScalar(spendScalar(match.R, scanKey, spendKey), match.P_stealth, msg);
  if (!ed25519.verify(sig, msg, match.P_stealth)) throw new Error("local sig verify failed");
  tx.addSignature(stealthPk, Buffer.from(sig));
  return tx.serialize({ requireAllSignatures: false }).toString("base64"); // relayer sig still missing
}
