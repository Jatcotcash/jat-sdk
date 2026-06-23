// Reconstruct the SEAL pool's Merkle tree from on-chain deposit history so any
// leaf's authentication path can be produced for a withdrawal proof. Leaves are
// not stored individually on-chain (only the incremental state is), so we read
// every `deposit` instruction (value + precommit, in chronological order = leaf
// index) and rebuild the tree with the same Poseidon + zero subtrees the program
// uses. Correctness is self-checked: the rebuilt root must equal the on-chain root.
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { buildPoseidon } from "circomlibjs";

export const POOL = new PublicKey("seuH78RmBPVzoKToLQVEZrDvuL5jDNBSbptozWK9PEm");
export const DEPTH = 20;
const DEPOSIT_DISC = createHash("sha256").update("global:deposit").digest().subarray(0, 8);

const treeStatePda = () => PublicKey.findProgramAddressSync([Buffer.from("tree")], POOL)[0];

// parse on-chain TreeState: 8 disc | currentRoot[32] | next_leaf_index u64 | filled[DEPTH][32] | zeros[DEPTH][32]
export function parseTreeState(data) {
  const d = data.subarray(8);
  const currentRoot = BigInt("0x" + d.subarray(0, 32).toString("hex"));
  const n = Number(d.readBigUInt64LE(32));
  const zeros = [];
  const ZOFF = 40 + 32 * DEPTH;
  for (let i = 0; i < DEPTH; i++) zeros.push(BigInt("0x" + d.subarray(ZOFF + i * 32, ZOFF + i * 32 + 32).toString("hex")));
  return { currentRoot, n, zeros };
}

// read all deposits (chronological) -> [{ value, precommit }], index = position
export async function fetchDeposits(conn) {
  const sigs = (await conn.getSignaturesForAddress(POOL, { limit: 1000 }))
    .filter((s) => !s.err)
    .reverse(); // oldest first
  const deposits = [];
  // getTransaction lies by omission: for a signature getSignaturesForAddress just
  // returned as confirmed, the node still answers `null` for a few seconds while
  // the tx propagates (seen on Helius devnet: a single pass nulled 20-60% of
  // confirmed sigs, every one resolving once retried with backoff). A `null` is
  // NOT "no such tx". The old code retried only on 429 and then `continue`-skipped
  // a null, silently dropping that deposit; since the leaf index is its position,
  // a dropped leaf shifts every later index and the rebuilt Merkle root no longer
  // matches on-chain. So we retry on null too, and if it's still null after the
  // budget we THROW rather than skip: a gap must abort the scan, not corrupt it.
  const getTx = async (signature) => {
    for (let attempt = 0; ; attempt++) {
      let tx;
      try {
        tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      } catch (e) {
        if (attempt >= 7 || !/429|Too Many/i.test(String(e?.message))) throw e;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1))); // backoff on public-RPC rate limit
        continue;
      }
      if (tx) return tx;
      if (attempt >= 7) throw new Error(`getTransaction returned null after retries for ${signature}; aborting scan to avoid a leaf gap`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  };
  for (const { signature } of sigs) {
    const tx = await getTx(signature); // throws on an unrecoverable null (never silently skips)
    await new Promise((r) => setTimeout(r, 120)); // gentle throttle
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    const ixs = msg.compiledInstructions ?? msg.instructions;
    for (const ix of ixs) {
      const pid = keys[ix.programIdIndex];
      if (!pid?.equals(POOL)) continue;
      const data = Buffer.from(ix.data?.length !== undefined && typeof ix.data !== "string" ? ix.data : Buffer.from(ix.data, "base64"));
      if (data.length < 8 || !data.subarray(0, 8).equals(DEPOSIT_DISC)) continue;
      const value = data.readBigUInt64LE(8);
      const precommit = BigInt("0x" + data.subarray(16, 48).toString("hex"));
      deposits.push({ value, precommit });
    }
  }
  return deposits;
}

// build the full depth-DEPTH tree from leaves + the program's zero subtrees.
// returns { root, pathFor(index) -> { pathElements, pathIndices } }.
export async function buildTree(leaves, zeros) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (a, b) => F.toObject(poseidon([a, b]));
  // level 0 = leaves, padded with zeros[level] up the tree
  let level = leaves.slice();
  const layers = [level];
  for (let d = 0; d < DEPTH; d++) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : zeros[d];
      next.push(H(l, r));
    }
    if (next.length === 0) next.push(H(zeros[d], zeros[d]));
    level = next;
    layers.push(level);
  }
  const root = layers[DEPTH][0];
  const pathFor = (index) => {
    const pathElements = [], pathIndices = [];
    let idx = index;
    for (let d = 0; d < DEPTH; d++) {
      const bit = idx & 1;
      pathIndices.push(bit);
      const sibIdx = bit ? idx - 1 : idx + 1;
      const sib = sibIdx < layers[d].length ? layers[d][sibIdx] : zeros[d];
      pathElements.push(sib);
      idx = idx >> 1;
    }
    return { pathElements, pathIndices };
  };
  return { root, pathFor };
}

// leaf_i = Poseidon(value, label=i, precommit)
export async function leavesFromDeposits(deposits) {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const H = (...xs) => F.toObject(poseidon(xs));
  return deposits.map((d, i) => H(d.value, BigInt(i), d.precommit));
}

// full reconstruction + self-check against the on-chain root.
export async function reconstruct(conn) {
  const ts = parseTreeState((await conn.getAccountInfo(treeStatePda())).data);
  const deposits = await fetchDeposits(conn);
  const leaves = await leavesFromDeposits(deposits);
  const { root, pathFor } = await buildTree(leaves, ts.zeros);
  return { root, onchainRoot: ts.currentRoot, matches: root === ts.currentRoot, n: ts.n, deposits, leaves, pathFor };
}

// CLI self-test: node sdk/pool_tree.mjs
if (process.argv[1] && import.meta.url.endsWith("pool_tree.mjs") && process.argv[1].endsWith("pool_tree.mjs")) {
  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const r = await reconstruct(conn);
  console.log("deposits parsed:", r.deposits.length, "| tree next_leaf_index:", r.n);
  console.log("reconstructed root:", r.root.toString());
  console.log("on-chain root     :", r.onchainRoot.toString());
  console.log(r.matches ? "ROOT MATCH: PASS" : "ROOT MATCH: FAIL");
  process.exit(r.matches ? 0 : 1);
}
