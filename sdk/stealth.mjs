// SEAL stealth SDK core (Ed25519, EIP-5564-style dual-key, ported to the
// prime-order Ed25519 group). All secret math is in-process; keys never leave
// the device. No ZK here: this is graph privacy (hide who paid whom) via pure
// ECDH key derivation, orthogonal to the SEAL pool's value privacy.
//
// Scheme: recipient holds two raw (unclamped) scalars p_spend, p_scan.
//   meta-address = (P_spend = p_spend*B, P_scan = p_scan*B)
//   payer: r random; R = r*B; Sx = r*P_scan; s_h = H(Sx) mod L; viewTag = H(Sx)[0]
//          P_stealth = P_spend + s_h*B            (the address to fund)
//   recipient: Sx = p_scan*R (identical); spend scalar p_stealth = (p_spend + s_h) mod L
// P_scan can be handed to an untrusted indexer to SCAN with no spend power.

import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToNumberLE, numberToBytesLE, concatBytes } from "@noble/curves/abstract/utils";
import { randomBytes } from "@noble/hashes/utils";

const B = ed25519.ExtendedPoint.BASE;
const L = ed25519.CURVE.n; // group order 2^252 + 27742317777372353535851937790883648493
const modL = (x) => ((x % L) + L) % L;
const scalarLE = (s) => numberToBytesLE(modL(s), 32);
const randScalar = () => modL(bytesToNumberLE(randomBytes(64))); // 64 bytes -> uniform mod L
const pointFrom = (bytes) => ed25519.ExtendedPoint.fromHex(bytes);

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));

// recipient: create a meta-address + a shareable payment link.
export function generateMetaAddress() {
  const p_spend = randScalar();
  const p_scan = randScalar();
  const P_spend = B.multiply(p_spend).toRawBytes();
  const P_scan = B.multiply(p_scan).toRawBytes();
  return {
    spendKey: scalarLE(p_spend), // 32 bytes, KEEP SECRET (spend power)
    scanKey: scalarLE(p_scan),   // 32 bytes, may delegate to an untrusted scanner
    P_spend, P_scan,
    link: "seal:pay:" + b64u(concatBytes(P_spend, P_scan)),
  };
}

export function parseLink(link) {
  const raw = unb64u(String(link).replace(/^seal:pay:/, ""));
  if (raw.length !== 64) throw new Error("bad SEAL payment link");
  return { P_spend: raw.slice(0, 32), P_scan: raw.slice(32, 64) };
}

// shared-secret hash -> (s_h scalar, viewTag byte). Identical on both sides.
function sharedToScalar(Sx_bytes) {
  const h = sha512(Sx_bytes);
  return { s_h: modL(bytesToNumberLE(h)), viewTag: h[0] };
}

// payer: derive a one-time stealth address from the recipient's meta-address.
export function payerDerive({ P_spend, P_scan }) {
  const r = randScalar();
  const R = B.multiply(r).toRawBytes();
  const Sx = pointFrom(P_scan).multiply(r).toRawBytes(); // ECDH
  const { s_h, viewTag } = sharedToScalar(Sx);
  const P_stealth = pointFrom(P_spend).add(B.multiply(s_h)).toRawBytes();
  return { P_stealth, R, viewTag };
}

// recipient (scan-only, needs p_scan + P_spend): which announcements are mine.
export function scan(announcements, scanKey, P_spend) {
  const p_scan = bytesToNumberLE(scanKey);
  const SP = pointFrom(P_spend);
  const mine = [];
  for (const ann of announcements) {
    const Sx = pointFrom(ann.R).multiply(p_scan).toRawBytes();
    const { s_h, viewTag } = sharedToScalar(Sx);
    if (viewTag !== ann.viewTag) continue; // 1-byte prefilter rejects ~255/256
    const P_stealth = SP.add(B.multiply(s_h)).toRawBytes();
    mine.push({ R: ann.R, P_stealth, s_h });
  }
  return mine;
}

// recipient (spend): one-time spend scalar for a matched announcement.
export function spendScalar(R, scanKey, spendKey) {
  const Sx = pointFrom(R).multiply(bytesToNumberLE(scanKey)).toRawBytes();
  const { s_h } = sharedToScalar(Sx);
  return modL(bytesToNumberLE(spendKey) + s_h); // p_stealth (raw additive scalar)
}

// Fix-B signer: RFC8032 Ed25519 over a RAW additive scalar (not a seed).
// DETERMINISTIC nonce bound to the message: r = SHA512( SHA256("SEAL-nonce"||a) || M ).
// Reusing a nonce across two messages leaks the scalar, so the message MUST be
// inside the nonce hash. Output verifies under ed25519_dalek verify_strict (Solana).
export function signWithScalar(scalar, P_stealth, msg) {
  const a = modL(scalar);
  const pfx = sha256(concatBytes(new TextEncoder().encode("SEAL-nonce"), scalarLE(a)));
  const r = modL(bytesToNumberLE(sha512(concatBytes(pfx, msg))));
  const Rb = B.multiply(r).toRawBytes();
  const k = modL(bytesToNumberLE(sha512(concatBytes(Rb, P_stealth, msg))));
  const S = modL(r + k * a);
  return concatBytes(Rb, scalarLE(S)); // 64-byte signature
}

export function verify(sig, msg, P_stealth) {
  return ed25519.verify(sig, msg, P_stealth);
}
