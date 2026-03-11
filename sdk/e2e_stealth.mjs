// Full stealth e2e on devnet against the deployed Announcer program:
//   recipient publishes a link -> payer funds + announces atomically ->
//   recipient scans on-chain (indexer path) -> recipient sweeps the funds.
// Run: SEAL_WALLET=./deploy-wallet.json node sdk/e2e_stealth.mjs
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import { generateMetaAddress } from "./stealth.mjs";
import { pay, scanOnChain, sweep, announcementPda } from "./client.mjs";

const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SEAL_WALLET || "./deploy-wallet.json"))));
const AMOUNT = 2_000_000; // 0.002 SOL
let checks = 0, failed = 0;
const check = (name, cond) => { checks++; if (!cond) { failed++; console.log("  FAIL:", name); } else console.log("  ok:", name); };

// recipient creates a meta-address + link (published off-chain, e.g. on a site)
const meta = generateMetaAddress();
console.log("recipient link:", meta.link, "\n");

// payer pays: fund stealth address + announce R atomically
console.log("[1] payer funds stealth + announces (one tx)...");
const { stealthPk, R, txid } = await pay(conn, payer, meta.link, AMOUNT);
console.log("  pay tx:", txid);
console.log("  stealth address:", stealthPk.toBase58());
check("announcement PDA was created", (await conn.getBalance(announcementPda(R))) > 0);
check("stealth address funded", (await conn.getBalance(stealthPk)) === AMOUNT);

// recipient scans on-chain with only the scan key (untrusted-indexer path)
console.log("[2] recipient scans on-chain (view-tag prefilter)...");
const matches = await scanOnChain(conn, meta.scanKey, meta.P_spend);
const found = matches.find((m) => Buffer.from(m.P_stealth).equals(stealthPk.toBytes()));
check("scan found our payment among all announcements", !!found);

// a foreign recipient does NOT find it
const stranger = generateMetaAddress();
const strangerMatches = await scanOnChain(conn, stranger.scanKey, stranger.P_spend);
check("stranger does NOT match our payment",
  !strangerMatches.some((m) => Buffer.from(m.P_stealth).equals(stealthPk.toBytes())));

// recipient sweeps the stealth funds to a destination of their choice
console.log("[3] recipient sweeps stealth funds...");
const dest = payer.publicKey; // for the test, sweep back to the funded wallet
const before = await conn.getBalance(dest);
const { txid: sweepTx, swept } = await sweep(conn, found, meta.scanKey, meta.spendKey, dest);
console.log("  sweep tx:", sweepTx, "swept", swept, "lamports");
check("stealth address drained", (await conn.getBalance(stealthPk)) < 5000);
check("destination received the swept funds", (await conn.getBalance(dest)) > before);

console.log(`\n${checks - failed}/${checks} checks passed`);
console.log(failed === 0 ? "STEALTH E2E: PASS" : "STEALTH E2E: FAIL");
process.exit(failed === 0 ? 0 : 1);
