// Offline test for the relayed-transfer builder: no cluster needed. Verifies the
// builder produces a transfer whose FEE is owed by the relayer while the stealth
// account's spend signature is valid, and the relayer signature slot is still
// open (to be filled by the relayer service). Run: node sdk/relay.test.mjs
import { Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { generateMetaAddress, parseLink, payerDerive, scan } from "./stealth.mjs";
import { buildRelayedTransfer } from "./client.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log("  FAIL:", n); } };

// a stub connection: the builder only needs a recent blockhash
const FAKE_BLOCKHASH = Keypair.generate().publicKey.toBase58(); // any 32-byte base58
const conn = { getLatestBlockhash: async () => ({ blockhash: FAKE_BLOCKHASH }) };

const meta = generateMetaAddress();
const { R, viewTag } = payerDerive(parseLink(meta.link));
const [match] = scan([{ R, viewTag }], meta.scanKey, meta.P_spend);
const stealthPk = new PublicKey(match.P_stealth);
const relayer = Keypair.generate();
const dest = Keypair.generate().publicKey;
const AMOUNT = 1_500_000;

const b64 = await buildRelayedTransfer(conn, match, meta.scanKey, meta.spendKey, dest, AMOUNT, relayer.publicKey);
const tx = Transaction.from(Buffer.from(b64, "base64"));

ok("feePayer is the relayer", tx.feePayer.equals(relayer.publicKey));
ok("one instruction", tx.instructions.length === 1);
ok("instruction is a System transfer", tx.instructions[0].programId.equals(SystemProgram.programId));
ok("transfer source is the stealth address", tx.instructions[0].keys[0].pubkey.equals(stealthPk));
ok("transfer dest is the recipient", tx.instructions[0].keys[1].pubkey.equals(dest));

// stealth account's signature is present and valid over the message
const msg = tx.serializeMessage();
const stealthSig = tx.signatures.find((s) => s.publicKey.equals(stealthPk))?.signature;
ok("stealth signature present", !!stealthSig);
ok("stealth signature verifies", !!stealthSig && ed25519.verify(new Uint8Array(stealthSig), msg, match.P_stealth));

// relayer signature slot is still empty (relayer service fills it before submit)
const relayerSig = tx.signatures.find((s) => s.publicKey.equals(relayer.publicKey))?.signature;
ok("relayer signature still unsigned", relayerSig === null);

// the relayer never appears inside the instruction (so it can only pay the fee)
ok("relayer not referenced in any instruction",
  !tx.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(relayer.publicKey))));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "RELAY TEST: PASS" : "RELAY TEST: FAIL");
process.exit(fail === 0 ? 0 : 1);
