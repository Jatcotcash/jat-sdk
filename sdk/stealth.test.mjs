// Unit tests for the SEAL stealth SDK core. Run: node sdk/stealth.test.mjs
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToNumberLE } from "@noble/curves/abstract/utils";
import nacl from "tweetnacl";
import {
  generateMetaAddress, parseLink, payerDerive, scan, spendScalar, signWithScalar, verify,
} from "./stealth.mjs";

const B = ed25519.ExtendedPoint.BASE;
const L = ed25519.CURVE.n;
let pass = 0, fail = 0;
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", name); } };

const TRIALS = 50;
for (let i = 0; i < TRIALS; i++) {
  // recipient meta-address + link round-trip
  const meta = generateMetaAddress();
  const parsed = parseLink(meta.link);
  ok("link round-trips P_spend", eq(parsed.P_spend, meta.P_spend));
  ok("link round-trips P_scan", eq(parsed.P_scan, meta.P_scan));

  // payer derives a one-time stealth address
  const { P_stealth, R, viewTag } = payerDerive(parsed);
  ok("P_stealth is a valid on-curve point", (() => { try { ed25519.ExtendedPoint.fromHex(P_stealth); return true; } catch { return false; } })());

  // recipient scans and finds it (view-tag prefilter + match)
  const matched = scan([{ R, viewTag }], meta.scanKey, meta.P_spend);
  ok("recipient scan finds the payment", matched.length === 1 && eq(matched[0].P_stealth, P_stealth));

  // a foreign announcement is NOT matched (different recipient)
  const other = generateMetaAddress();
  const foreign = payerDerive(other); // for `other`, not us
  const noMatch = scan([{ R: foreign.R, viewTag: foreign.viewTag }], meta.scanKey, meta.P_spend);
  ok("foreign announcement not matched", noMatch.length === 0);

  // recipient derives the spend scalar; it generates P_stealth (additive consistency)
  const p_stealth = spendScalar(R, meta.scanKey, meta.spendKey);
  ok("p_stealth*B == P_stealth", eq(B.multiply(p_stealth).toRawBytes(), P_stealth));

  // CLAMP TRAP: feeding p_stealth bytes AS a seed yields a DIFFERENT pubkey
  const seedKp = nacl.sign.keyPair.fromSeed(new Uint8Array(Buffer.from(p_stealth.toString(16).padStart(64, "0"), "hex")));
  ok("seed-API does NOT reproduce P_stealth (clamp trap real)", !eq(seedKp.publicKey, P_stealth));

  // raw-scalar signature verifies (and is canonical S < L)
  const msg = new TextEncoder().encode("seal stealth tx " + i);
  const sig = signWithScalar(p_stealth, P_stealth, msg);
  ok("raw-scalar signature verifies", verify(sig, msg, P_stealth));
  ok("signature S is canonical (< L)", bytesToNumberLE(sig.slice(32, 64)) < L);

  // deterministic nonce: same (scalar,msg) -> identical signature
  const sig2 = signWithScalar(p_stealth, P_stealth, msg);
  ok("nonce is deterministic per (scalar,msg)", eq(sig, sig2));
  // different message -> different signature
  const sig3 = signWithScalar(p_stealth, P_stealth, new TextEncoder().encode("other"));
  ok("different message -> different signature", !eq(sig, sig3));
}

console.log(`\n${pass} passed, ${fail} failed (${TRIALS} trials)`);
console.log(fail === 0 ? "SDK CORE: PASS" : "SDK CORE: FAIL");
process.exit(fail === 0 ? 0 : 1);
