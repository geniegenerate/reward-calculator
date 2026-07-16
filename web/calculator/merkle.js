/**
 * merkle.js — browser-side mirror of the backend's internal/reward/rewardmerkle.
 *
 * Recomputes the input/result Merkle roots the RewardVerifier contract holds:
 *   - leaves are keccak256(abi.encode(...)) over the committed fields, with all
 *     USDT amounts as exact integer micro-units (amount × 10^6, 6dp model);
 *   - trees use OpenZeppelin commutative (sorted-pair) keccak256 hashing,
 *     leaves ordered by ordering_key ascending, odd nodes promoted unchanged.
 *
 * Everything here is standard primitives (BigInt, keccak256) so a reviewer can
 * check it against the published Go source line by line.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sha3.js').keccak256);
  } else {
    root.rewardMerkle = factory(root.keccak256);
  }
})(typeof self !== 'undefined' ? self : this, function (keccak256) {
  'use strict';

  // ---- 6dp amount parsing ---------------------------------------------------

  /**
   * Parse an exact 6dp decimal string ("1616.642910") into integer micro-units
   * as BigInt. Rejects negatives and sub-micro precision — matching the
   * backend's toMicros, which panics on either (they must never appear in a
   * committed artifact).
   */
  function toMicros(s) {
    if (typeof s !== 'string' || !/^\d+(\.\d{1,6})?$/.test(s)) {
      throw new Error('invalid 6dp amount: ' + JSON.stringify(s));
    }
    const [whole, frac = ''] = s.split('.');
    return BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, '0'));
  }

  // ---- abi.encode (static types only) ----------------------------------------

  /** Encode one unsigned integer as a 32-byte big-endian ABI word. */
  function word(value) {
    const v = BigInt(value);
    if (v < 0n) throw new Error('negative value in ABI word');
    const out = new Uint8Array(32);
    let x = v;
    for (let i = 31; i >= 0 && x > 0n; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    if (x > 0n) throw new Error('value exceeds 256 bits');
    return out;
  }

  function concat(words) {
    const out = new Uint8Array(words.length * 32);
    words.forEach((w, i) => out.set(w, i * 32));
    return out;
  }

  function hexToBytes(hex) {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) {
      throw new Error('invalid hex: ' + hex);
    }
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(h.substr(i * 2, 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    let s = '0x';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  function keccakBytes(bytes) {
    return new Uint8Array(keccak256.arrayBuffer(bytes));
  }

  // ---- leaf hashes ------------------------------------------------------------

  /**
   * Input leaf: keccak256(abi.encode(uint64 ordering_key, uint32 loyalty_score,
   * uint64 completion_rank, uint256 lifetime_earnings_micros,
   * uint256 wallet_balance_micros, uint256 max_capacity_micros)).
   * `p` is one participant object from the published input snapshot.
   */
  function inputLeafHash(p) {
    return keccakBytes(concat([
      word(p.ordering_key),
      word(p.loyalty_score),
      word(p.completion_rank),
      word(toMicros(p.lifetime_earnings_usdt)),
      word(toMicros(p.wallet_balance_usdt)),
      word(toMicros(p.max_capacity_usdt)),
    ]));
  }

  /**
   * Result leaf: keccak256(abi.encode(uint64 ordering_key,
   * uint256 loyalty_reward, uint256 newcomer_reward, uint256 credited_amount,
   * uint256 excess_amount, bool was_over_cap)) — amounts in micro-units.
   * `m` is one member object shaped like the calculator's output
   * (6dp decimal strings; `normalize6` them first if needed).
   */
  function resultLeafHash(m) {
    return keccakBytes(concat([
      word(m.ordering_key),
      word(toMicros(m.loyalty_reward)),
      word(toMicros(m.newcomer_reward)),
      word(toMicros(m.credited_amount)),
      word(toMicros(m.excess_amount)),
      word(m.was_over_cap ? 1n : 0n),
    ]));
  }

  /**
   * The calculator's JSON output prints decimals in minimal form ("0" not
   * "0.000000"); the committed artifacts use StringFixed(6). Both are the same
   * exact value — normalize to 6dp before micro-conversion.
   */
  function normalize6(s) {
    if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s)) {
      throw new Error('invalid decimal: ' + JSON.stringify(s));
    }
    const [whole, frac = ''] = s.split('.');
    if (frac.length > 6 && /[^0]/.test(frac.slice(6))) {
      throw new Error('sub-micro precision: ' + s);
    }
    return whole + '.' + frac.slice(0, 6).padEnd(6, '0');
  }

  // ---- sorted-pair tree ---------------------------------------------------------

  function bytesLess(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  /** OpenZeppelin commutative node hash: keccak256 of children in ascending byte order. */
  function hashPair(a, b) {
    const joined = new Uint8Array(64);
    if (bytesLess(a, b)) {
      joined.set(a, 0); joined.set(b, 32);
    } else {
      joined.set(b, 0); joined.set(a, 32);
    }
    return keccakBytes(joined);
  }

  /**
   * Build the root from leaf hashes in committed order (callers sort by
   * ordering_key ascending first). Odd nodes are promoted unchanged.
   */
  function treeRoot(leaves) {
    if (leaves.length === 0) throw new Error('cannot build a tree with zero leaves');
    let layer = leaves;
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        next.push(i + 1 === layer.length ? layer[i] : hashPair(layer[i], layer[i + 1]));
      }
      layer = next;
    }
    return layer[0];
  }

  /** Input root from the published snapshot's participants array. */
  function inputRootFromSnapshot(participants) {
    const sorted = [...participants].sort((a, b) => a.ordering_key - b.ordering_key);
    return bytesToHex(treeRoot(sorted.map(inputLeafHash)));
  }

  /**
   * Result root from calculator-output members (already carrying ordering_key).
   * Amount fields are normalized, so raw calculator output can be passed as-is.
   */
  function resultRootFromMembers(members) {
    const sorted = [...members].sort((a, b) => a.ordering_key - b.ordering_key);
    return bytesToHex(treeRoot(sorted.map((m) => resultLeafHash({
      ordering_key: m.ordering_key,
      loyalty_reward: normalize6(m.loyalty_reward),
      newcomer_reward: normalize6(m.newcomer_reward),
      credited_amount: normalize6(m.credited_amount),
      excess_amount: normalize6(m.excess_amount),
      was_over_cap: m.was_over_cap,
    }))));
  }

  return {
    toMicros,
    normalize6,
    inputLeafHash,
    resultLeafHash,
    treeRoot,
    inputRootFromSnapshot,
    resultRootFromMembers,
    hexToBytes,
    bytesToHex,
  };
});
