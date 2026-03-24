// SEAL fee relayer: pays the transaction fee (and any small protocol PDA rent) so
// a recipient with a zero-history stealth account never originates a fee, which is
// the main deanonymization path. The client builds a tx with feePayer = relayer
// and signs the other parties; the relayer co-signs and submits.
//
// Production hardening (the relayer holds funds, so it must not be drainable):
//   - program allowlist (System, ComputeBudget, SEAL pool, SEAL announcer)
//   - the relayer may never appear in a System instruction (no transfer/create
//     funded by it); in pool/announcer instructions it may be the fee payer only
//   - SIMULATION COST CAP: the tx is simulated and rejected if the relayer's net
//     cost (fee + any lamports it loses) exceeds MAX_RELAYER_COST_LAMPORTS. This
//     bounds drain per request regardless of instruction shape.
//   - per-IP and global rate limits; minimum-balance floor; size/ix-count caps
//
// POST /relay  { tx: <base64 partially-signed tx> }  -> { signature }
// GET  /health                                       -> { ok, relayer }
//
// Run: RELAYER_WALLET=./relayer.json RPC_URL=... node sdk/relayer.mjs  (PORT=8789)
import http from "node:http";
import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT || 8789);
const MAX_COST = Number(process.env.MAX_RELAYER_COST_LAMPORTS || 10_000_000); // 0.01 SOL / tx
const MIN_BALANCE = Number(process.env.RELAYER_MIN_BALANCE_LAMPORTS || 50_000_000); // 0.05 SOL floor
const RATE_PER_MIN = Number(process.env.RELAYER_RATE_PER_MIN || 20); // per IP
const GLOBAL_PER_MIN = Number(process.env.RELAYER_GLOBAL_PER_MIN || 120);
const MAX_TX_BYTES = 1232; // a Solana packet
const MAX_IXS = 4;
const conn = new Connection(RPC_URL, "confirmed");
const relayer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.RELAYER_WALLET || "./deploy-wallet.json"))),
);

const ALLOWED = new Set([
  SystemProgram.programId.toBase58(),
  "ComputeBudget111111111111111111111111111111",
  "seuH78RmBPVzoKToLQVEZrDvuL5jDNBSbptozWK9PEm", // SEAL pool
  "seaWHA64tVzN8yfa33bE6cvqKRSxVp3R6c7Ts5NXPM9", // SEAL announcer
]);
const SYS = SystemProgram.programId.toBase58();

// --- rate limiting (in-memory token windows) -------------------------------
const hits = new Map(); // ip -> number[] (timestamps ms)
let globalHits = [];
function rateLimited(ip, now) {
  const cut = now - 60_000;
  globalHits = globalHits.filter((t) => t > cut);
  if (globalHits.length >= GLOBAL_PER_MIN) return "global rate limit";
  const arr = (hits.get(ip) || []).filter((t) => t > cut);
  if (arr.length >= RATE_PER_MIN) return "rate limit";
  arr.push(now); hits.set(ip, arr); globalHits.push(now);
  return null;
}

// --- structural validation --------------------------------------------------
function structuralReject(tx) {
  if (!tx.feePayer?.equals(relayer.publicKey)) return "feePayer must be the relayer";
  if (tx.instructions.length === 0 || tx.instructions.length > MAX_IXS) return "instruction count out of range";
  for (const ix of tx.instructions) {
    if (!ALLOWED.has(ix.programId.toBase58())) return `program not allowed: ${ix.programId.toBase58()}`;
    // the relayer must never be referenced inside a System instruction (would let
    // a transfer/createAccount/allocate be funded by the relayer). In pool and
    // announcer instructions it may be the fee payer, where its only cost is the
    // fee plus a small fixed PDA rent, which the simulation cap then bounds.
    if (ix.programId.toBase58() === SYS && ix.keys.some((k) => k.pubkey.equals(relayer.publicKey))) {
      return "relayer referenced in a System instruction";
    }
  }
  return null;
}

// --- simulation cost cap: reject if the relayer would lose more than MAX_COST -
async function costReject(tx) {
  const pre = await conn.getBalance(relayer.publicKey);
  if (pre < MIN_BALANCE) return "relayer balance below floor";
  const signed = Transaction.from(tx.serialize({ requireAllSignatures: false }));
  signed.partialSign(relayer);
  // legacy Transaction overload: (tx, signers?, includeAccounts?). Returns the
  // relayer account's simulated post-state so we can bound its lamport cost.
  const sim = await conn.simulateTransaction(signed, undefined, [relayer.publicKey]);
  if (sim.value.err) return `simulation failed: ${JSON.stringify(sim.value.err)}`;
  const post = sim.value.accounts?.[0]?.lamports ?? pre; // sim shows rent the relayer pays (fee not deducted)
  const feeMsg = await conn.getFeeForMessage(tx.compileMessage()).catch(() => null);
  const fee = feeMsg?.value ?? 5000;
  const cost = (pre - post) + fee;
  if (cost > MAX_COST) return `relayer cost ${cost} exceeds cap ${MAX_COST}`;
  return null;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === "GET" && req.url === "/health")
      return json(res, 200, { ok: true, relayer: relayer.publicKey.toBase58() });
    if (req.method !== "POST" || req.url !== "/relay") return json(res, 404, { error: "not found" });

    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();
    const limited = rateLimited(ip, Date.now());
    if (limited) return json(res, 429, { error: limited });

    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", async () => {
      try {
        const { tx: b64 } = JSON.parse(body || "{}");
        if (!b64) return json(res, 400, { error: "missing tx" });
        const raw = Buffer.from(b64, "base64");
        if (raw.length > MAX_TX_BYTES) return json(res, 400, { error: "tx too large" });
        const tx = Transaction.from(raw);
        const bad = structuralReject(tx) || (await costReject(tx));
        if (bad) return json(res, 400, { error: bad });
        tx.partialSign(relayer);
        const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await conn.confirmTransaction(signature, "confirmed");
        return json(res, 200, { signature });
      } catch (e) {
        return json(res, 500, { error: String(e?.message || e) });
      }
    });
  })
  .listen(PORT, () => console.log(`SEAL relayer ${relayer.publicKey.toBase58()} on :${PORT} (rpc ${RPC_URL}, cost cap ${MAX_COST})`));
