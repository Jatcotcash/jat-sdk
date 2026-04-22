// Stealth crypto core (Ed25519 dual-key, EIP-5564 lineage on the prime-order
// group). Isomorphic: no Node Buffer, no browser btoa. All secret math stays in
// process; keys never leave the caller. No ZK here, this is graph privacy via
// ECDH. See the SEAL DESIGN_stealth doc for the scheme and the Fix-B signer.
import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToNumberLE, numberToBytesLE, concatBytes } from "@noble/curves/abstract/utils";
import { randomBytes } from "@noble/hashes/utils";

const B = ed25519.ExtendedPoint.BASE;
const L = ed25519.CURVE.n;
const modL = (x: bigint) => ((x % L) + L) % L;
const scalarLE = (s: bigint) => numberToBytesLE(modL(s), 32);
const randScalar = () => modL(bytesToNumberLE(randomBytes(64)));
const pointFrom = (b: Uint8Array) => ed25519.ExtendedPoint.fromHex(b);

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64url(bytes: Uint8Array): string {
  let s = "", i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) { const n = bytes[i] << 16; s += A[(n >> 18) & 63] + A[(n >> 12) & 63]; }
  else if (rem === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63]; }
  return s;
}
function unb64url(s: string): Uint8Array {
  const inv: Record<string, number> = {};
  for (let i = 0; i < A.length; i++) inv[A[i]] = i;
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const c of s) { buf = (buf << 6) | inv[c]; bits += 6; if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); } }
  return new Uint8Array(out);
}
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/.{1,2}/g)!.map((x) => parseInt(x, 16)));

export interface MetaAddress {
  link: string;
  spendKey: string; // hex, SECRET (spend power)
  scanKey: string;  // hex, delegatable to an untrusted indexer
  P_spend: Uint8Array;
  P_scan: Uint8Array;
}
export interface Announcement { R: Uint8Array; viewTag: number; }
export interface StealthMatch { R: Uint8Array; P_stealth: Uint8Array; }

/** Recipient: create a meta-address + shareable payment link. */
export function generateMetaAddress(): MetaAddress {
  const pSpend = randScalar(), pScan = randScalar();
  const P_spend = B.multiply(pSpend).toRawBytes();
  const P_scan = B.multiply(pScan).toRawBytes();
  return { link: "seal:pay:" + b64url(concatBytes(P_spend, P_scan)), spendKey: toHex(scalarLE(pSpend)), scanKey: toHex(scalarLE(pScan)), P_spend, P_scan };
}

export function parseLink(link: string): { P_spend: Uint8Array; P_scan: Uint8Array } {
  const raw = unb64url(link.replace(/^seal:pay:/, ""));
  if (raw.length !== 64) throw new Error("invalid SEAL payment link");
  return { P_spend: raw.slice(0, 32), P_scan: raw.slice(32, 64) };
}

function sharedToScalar(Sx: Uint8Array) {
  const h = sha512(Sx);
  return { s_h: modL(bytesToNumberLE(h)), viewTag: h[0] };
}

/** Payer: derive a one-time stealth address from a meta-address. */
export function payerDerive(meta: { P_spend: Uint8Array; P_scan: Uint8Array }) {
  const r = randScalar();
  const R = B.multiply(r).toRawBytes();
  const { s_h, viewTag } = sharedToScalar(pointFrom(meta.P_scan).multiply(r).toRawBytes());
  const P_stealth = pointFrom(meta.P_spend).add(B.multiply(s_h)).toRawBytes();
  return { P_stealth, R, viewTag };
}

/** Recipient (scan key only): which announcements are mine. */
export function scan(anns: Announcement[], scanKeyHex: string, P_spend: Uint8Array): StealthMatch[] {
  const pScan = bytesToNumberLE(fromHex(scanKeyHex));
  const SP = pointFrom(P_spend);
  const mine: StealthMatch[] = [];
  for (const ann of anns) {
    const { s_h, viewTag } = sharedToScalar(pointFrom(ann.R).multiply(pScan).toRawBytes());
    if (viewTag !== ann.viewTag) continue;
    mine.push({ R: ann.R, P_stealth: SP.add(B.multiply(s_h)).toRawBytes() });
  }
  return mine;
}

/** Recipient (spend): one-time spend scalar for a matched announcement. */
export function spendScalar(R: Uint8Array, scanKeyHex: string, spendKeyHex: string): bigint {
  const { s_h } = sharedToScalar(pointFrom(R).multiply(bytesToNumberLE(fromHex(scanKeyHex))).toRawBytes());
  return modL(bytesToNumberLE(fromHex(spendKeyHex)) + s_h);
}

/** Fix-B signer: RFC8032 over a raw additive scalar, deterministic message-bound nonce. */
export function signWithScalar(scalar: bigint, P_stealth: Uint8Array, msg: Uint8Array): Uint8Array {
  const a = modL(scalar);
  const pfx = sha256(concatBytes(new TextEncoder().encode("SEAL-nonce"), scalarLE(a)));
  const r = modL(bytesToNumberLE(sha512(concatBytes(pfx, msg))));
  const Rb = B.multiply(r).toRawBytes();
  const k = modL(bytesToNumberLE(sha512(concatBytes(Rb, P_stealth, msg))));
  return concatBytes(Rb, scalarLE(modL(r + k * a)));
}

/** Public point P = secret*B from a hex scalar (rebuild P_spend for scanning). */
export function pubFromSecretHex(hex: string): Uint8Array {
  return B.multiply(modL(bytesToNumberLE(fromHex(hex)))).toRawBytes();
}

export { toHex, fromHex };
