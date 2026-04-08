// SEAL announcement indexer: a thin, UNTRUSTED service. It enumerates the
// announcer program's accounts and serves them raw; it never receives a scan
// key, so it cannot tell which announcement belongs to whom. The client scans
// locally with its own scan key (sdk/stealth.js `scan`). Running your own
// indexer or pointing at someone else's makes no privacy difference: the data
// is public either way, and the linking secret stays on the client.
//
// GET /announcements?since=<slot>   -> { announcements: [{ r, viewTag, scheme, slot }], tip }
// GET /health                       -> { ok: true }
//
// Run: RPC_URL=https://api.devnet.solana.com node sdk/indexer.mjs   (PORT=8788)
import http from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchDeposits, parseTreeState, POOL } from "./pool_tree.mjs";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT || 8788);
const ANNOUNCER = new PublicKey("seaWHA64tVzN8yfa33bE6cvqKRSxVp3R6c7Ts5NXPM9");
const ANN_SIZE = 8 + 32 + 1 + 1 + 8;
const conn = new Connection(RPC_URL, "confirmed");
const hex = (b) => Buffer.from(b).toString("hex");

async function listAnnouncements(sinceSlot = 0) {
  const accts = await conn.getProgramAccounts(ANNOUNCER, { filters: [{ dataSize: ANN_SIZE }] });
  return accts
    .map(({ account }) => ({
      r: hex(account.data.subarray(8, 40)),
      viewTag: account.data[40],
      scheme: account.data[41],
      slot: Number(account.data.readBigUInt64LE(42)),
    }))
    .filter((a) => a.slot >= sinceSlot)
    .sort((a, b) => a.slot - b.slot);
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      if (url.pathname === "/announcements") {
        const since = Number(url.searchParams.get("since") || 0);
        const announcements = await listAnnouncements(since);
        const tip = await conn.getSlot();
        return json(res, 200, { announcements, tip });
      }
      // pool leaves + zeros: the client rebuilds the Merkle tree and its own path
      // locally, so the indexer never learns which leaf a recipient withdraws.
      if (url.pathname === "/pool/leaves") {
        const ts = parseTreeState((await conn.getAccountInfo(
          PublicKey.findProgramAddressSync([Buffer.from("tree")], POOL)[0])).data);
        const deposits = await fetchDeposits(conn);
        return json(res, 200, {
          leaves: deposits.map((d, i) => ({ index: i, value: d.value.toString(), precommit: d.precommit.toString() })),
          zeros: ts.zeros.map((z) => z.toString()),
          root: ts.currentRoot.toString(),
          n: ts.n,
        });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  })
  .listen(PORT, () => console.log(`SEAL indexer on :${PORT} (rpc ${RPC_URL})`));
