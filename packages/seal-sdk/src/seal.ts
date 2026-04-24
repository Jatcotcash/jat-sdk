// createSeal(config): the on-chain client other apps embed. Config is injected
// (no env, no globals), so a host app supplies its own RPC connection, relayer,
// indexer, and circuit-artifact URLs. Isomorphic (Node + browser).
import { Buffer } from "buffer";
import {
  Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import {
  parseLink, payerDerive, scan, spendScalar, signWithScalar,
  type StealthMatch, type Announcement,
} from "./stealth.js";

export const DEFAULTS = {
  announcerProgramId: "seaWHA64tVzN8yfa33bE6cvqKRSxVp3R6c7Ts5NXPM9",
  poolProgramId: "seuH78RmBPVzoKToLQVEZrDvuL5jDNBSbptozWK9PEm",
};
export const DENOMS = [5_000, 50_000_000, 100_000_000, 1_000_000_000];
export const isDenom = (lamports: number) => DENOMS.includes(lamports);
const ANN_SIZE = 8 + 32 + 1 + 1 + 8;
const DEPTH = 20;
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export interface SealConfig {
  connection: Connection;
  /** base URL of a SEAL fee relayer (POST /relay, GET /health). Required for relayed claims + withdraw. */
  relayerUrl?: string;
  /** base URL of a SEAL indexer (GET /announcements, GET /pool/leaves). Falls back to direct RPC for scans. */
  indexerUrl?: string;
  /** URLs the browser/Node fetches the withdraw circuit artifacts from. Required for withdraw. */
  withdrawWasmUrl?: string;
  withdrawZkeyUrl?: string;
  announcerProgramId?: string;
  poolProgramId?: string;
}

/** Minimal wallet shape (compatible with @solana/wallet-adapter). */
export interface WalletLike {
  publicKey: PublicKey | null;
  sendTransaction: (tx: Transaction, conn: Connection) => Promise<string>;
}
export interface PoolNote { signature: string; nullifier: string; secret: string; }

const disc = (n: string) => Buffer.from(sha256(new TextEncoder().encode("global:" + n)).slice(0, 8));
const be32 = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const u64le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const g1neg = (p: string[]) => Buffer.concat([be32(BigInt(p[0])), be32((Q - (BigInt(p[1]) % Q)) % Q)]);
const g1 = (p: string[]) => Buffer.concat([be32(BigInt(p[0])), be32(BigInt(p[1]))]);
const g2 = (p: string[][]) => Buffer.concat([be32(BigInt(p[0][1])), be32(BigInt(p[0][0])), be32(BigInt(p[1][1])), be32(BigInt(p[1][0]))]);
const rand24 = () => BigInt("0x" + Array.from(randomBytes(24), (x) => x.toString(16).padStart(2, "0")).join(""));

export function createSeal(cfg: SealConfig) {
  const conn = cfg.connection;
  const ANNOUNCER = new PublicKey(cfg.announcerProgramId ?? DEFAULTS.announcerProgramId);
  const POOL = new PublicKey(cfg.poolProgramId ?? DEFAULTS.poolProgramId);
  const treeState = PublicKey.findProgramAddressSync([Buffer.from("tree")], POOL)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault")], POOL)[0];
  const relayerPubkey = async () => new PublicKey((await fetch(`${cfg.relayerUrl}/health`).then((r) => r.json())).relayer);
  const relay = async (tx: Transaction) => {
    const out = await fetch(`${cfg.relayerUrl}/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false }).toString("base64") }) }).then((r) => r.json());
    if (out.error) throw new Error(out.error);
    return out.signature as string;
  };

  const announcementPda = (R: Uint8Array) =>
    PublicKey.findProgramAddressSync([Buffer.from("ann"), Buffer.from(R)], ANNOUNCER)[0];

  const announceIx = (payer: PublicKey, R: Uint8Array, viewTag: number, scheme = 0) =>
    new TransactionInstruction({
      programId: ANNOUNCER,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: announcementPda(R), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("announce"), Buffer.from(R), Buffer.from([viewTag & 0xff]), Buffer.from([scheme & 0xff])]),
    });

  // payer (wallet): fund the derived stealth address + announce, one tx.
  async function pay(wallet: WalletLike, link: string, lamports: number) {
    if (!wallet.publicKey) throw new Error("connect a wallet first");
    const { P_stealth, R, viewTag } = payerDerive(parseLink(link));
    const stealthPk = new PublicKey(P_stealth);
    const tx = new Transaction()
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stealthPk, lamports }))
      .add(announceIx(wallet.publicKey, R, viewTag));
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const txid = await wallet.sendTransaction(tx, conn);
    await conn.confirmTransaction(txid, "confirmed");
    return { stealthPk, txid };
  }

  async function fetchAnnouncements(): Promise<Announcement[]> {
    if (cfg.indexerUrl) {
      const { announcements } = await fetch(`${cfg.indexerUrl}/announcements`).then((r) => r.json());
      return announcements.map((a: { r: string; viewTag: number }) => ({ R: hexToBytes(a.r), viewTag: a.viewTag }));
    }
    const accts = await conn.getProgramAccounts(ANNOUNCER, { filters: [{ dataSize: ANN_SIZE }] });
    return accts.map(({ account }) => ({ R: new Uint8Array(account.data.subarray(8, 40)), viewTag: account.data[40] }));
  }

  // recipient: find payments for our keys, with balances.
  async function scanOnChain(scanKey: string, P_spend: Uint8Array) {
    const matches = scan(await fetchAnnouncements(), scanKey, P_spend);
    return Promise.all(matches.map(async (m) => ({ ...m, address: new PublicKey(m.P_stealth), lamports: await conn.getBalance(new PublicKey(m.P_stealth)) })));
  }

  // claim to a plain address: relayer pays the fee so the stealth account never does.
  async function claimToAddress(match: StealthMatch, scanKey: string, spendKey: string, dest: string, lamports: number) {
    if (!cfg.relayerUrl) throw new Error("set relayerUrl");
    const relayer = await relayerPubkey();
    const stealthPk = new PublicKey(match.P_stealth);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: stealthPk, toPubkey: new PublicKey(dest), lamports }));
    tx.feePayer = relayer;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sig = signWithScalar(spendScalar(match.R, scanKey, spendKey), match.P_stealth, tx.serializeMessage());
    tx.addSignature(stealthPk, Buffer.from(sig));
    return relay(tx);
  }

  // claim INTO the pool (value privacy). Returns the note to withdraw later.
  async function claimIntoPool(match: StealthMatch, scanKey: string, spendKey: string, lamports: number): Promise<PoolNote> {
    if (!cfg.relayerUrl) throw new Error("set relayerUrl");
    if (!isDenom(lamports)) throw new Error("amount is not a pool denomination");
    const relayer = await relayerPubkey();
    const nullifier = rand24(), secret = rand24();
    const precommit = poseidon2([nullifier, secret]);
    const stealthPk = new PublicKey(match.P_stealth);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(new TransactionInstruction({
        programId: POOL,
        keys: [
          { pubkey: treeState, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: stealthPk, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("deposit"), u64le(BigInt(lamports)), be32(precommit)]),
      }));
    tx.feePayer = relayer;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sig = signWithScalar(spendScalar(match.R, scanKey, spendKey), match.P_stealth, tx.serializeMessage());
    tx.addSignature(stealthPk, Buffer.from(sig));
    return { signature: await relay(tx), nullifier: nullifier.toString(), secret: secret.toString() };
  }

  // withdraw a pool note to a fresh address (value-private). ZK proof generated here.
  async function withdraw(note: { nullifier: string; secret: string }, denom: number, dest: string) {
    if (!cfg.relayerUrl) throw new Error("set relayerUrl");
    if (!cfg.indexerUrl) throw new Error("set indexerUrl");
    if (!cfg.withdrawWasmUrl || !cfg.withdrawZkeyUrl) throw new Error("set withdrawWasmUrl + withdrawZkeyUrl");
    const nullifier = BigInt(note.nullifier), secret = BigInt(note.secret);
    const precommit = poseidon2([nullifier, secret]);
    const pool = await fetch(`${cfg.indexerUrl}/pool/leaves`).then((r) => r.json());
    const mine = pool.leaves.find((d: any) => BigInt(d.precommit) === precommit && BigInt(d.value) === BigInt(denom));
    if (!mine) throw new Error("no matching pool deposit for these keys");
    const { root, pathElements, pathIndices } = buildPath(pool, mine.index);

    const destPk = new PublicKey(dest);
    const nfW = poseidon1([nullifier]);
    const rb = destPk.toBytes();
    const recipientHash = poseidon2([BigInt("0x" + toHex(rb.slice(0, 16))), BigInt("0x" + toHex(rb.slice(16, 32)))]);
    const { proof } = await snarkjs.groth16.fullProve({
      merkleRoot: root.toString(), value: denom.toString(), recipientHash: recipientHash.toString(), nullifierHash: nfW.toString(),
      label: mine.index.toString(), secret: secret.toString(), nullifier: nullifier.toString(),
      pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
    }, cfg.withdrawWasmUrl, cfg.withdrawZkeyUrl);

    const relayer = await relayerPubkey();
    const [wNf] = PublicKey.findProgramAddressSync([Buffer.from("wnf"), be32(nfW)], POOL);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(new TransactionInstruction({
        programId: POOL,
        keys: [
          { pubkey: treeState, isSigner: false, isWritable: false },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: destPk, isSigner: false, isWritable: true },
          { pubkey: wNf, isSigner: false, isWritable: true },
          { pubkey: relayer, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("withdraw"), g1neg(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c), be32(root), be32(BigInt(denom)), be32(recipientHash), be32(nfW)]),
      }));
    tx.feePayer = relayer;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    return { signature: await relay(tx), index: mine.index as number };
  }

  return { announcementPda, pay, fetchAnnouncements, scanOnChain, claimToAddress, claimIntoPool, withdraw, programs: { announcer: ANNOUNCER, pool: POOL } };
}

// client-side tree reconstruction for a leaf's authentication path.
function buildPath(pool: { leaves: { index: number; value: string; precommit: string }[]; zeros: string[] }, leafIndex: number) {
  const zeros = pool.zeros.map(BigInt);
  let level = pool.leaves.map((d) => poseidon3([BigInt(d.value), BigInt(d.index), BigInt(d.precommit)]));
  const layers = [level];
  for (let d = 0; d < DEPTH; d++) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(poseidon2([level[i], i + 1 < level.length ? level[i + 1] : zeros[d]]));
    if (next.length === 0) next.push(poseidon2([zeros[d], zeros[d]]));
    level = next; layers.push(level);
  }
  const root = layers[DEPTH][0];
  const pathElements: bigint[] = [], pathIndices: number[] = [];
  let idx = leafIndex;
  for (let d = 0; d < DEPTH; d++) {
    const bit = idx & 1; pathIndices.push(bit);
    const sib = bit ? idx - 1 : idx + 1;
    pathElements.push(sib < layers[d].length ? layers[d][sib] : zeros[d]);
    idx >>= 1;
  }
  return { root, pathElements, pathIndices };
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h: string) => new Uint8Array(h.match(/.{1,2}/g)!.map((x) => parseInt(x, 16)));
