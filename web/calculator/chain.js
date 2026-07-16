/**
 * chain.js — read the on-chain commitment straight from the RewardVerifier
 * contract over public JSON-RPC (eth_call, no wallet, no server of ours).
 *
 * The chain is the trust anchor of the whole scheme: the roots this returns
 * were committed in an immutable transaction BEFORE any reward was credited.
 * If you distrust the RPC endpoints too, read the same values on BscScan —
 * the page links the contract for exactly that.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./sha3.js').keccak256);
  } else {
    root.rewardChain = factory(root.keccak256);
  }
})(typeof self !== 'undefined' ? self : this, function (keccak256) {
  'use strict';

  // RewardVerifier on BSC testnet (see README "On-chain anchor").
  const CONTRACT = '0x7fFeeEa9ED233B7c50aD291A4d8044249ABF2174';
  const EXPLORER = 'https://testnet.bscscan.com/address/' + CONTRACT + '#readContract';
  const RPC_ENDPOINTS = [
    'https://bsc-testnet.publicnode.com',
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    'https://bsc-testnet-rpc.publicnode.com',
  ];

  // keccak256("getCommitment(uint256)")[0:4]
  const GET_COMMITMENT_SELECTOR = '0x' + keccak256('getCommitment(uint256)').slice(0, 8);

  /** "2026-07-15" → unix seconds of 00:00 UTC that day, as 32-byte hex word. */
  function challengeDateWord(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) throw new Error('invalid challenge date: ' + dateStr);
    const secs = Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
    return secs.toString(16).padStart(64, '0');
  }

  async function rpcCall(endpoint, dateStr) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          { to: CONTRACT, data: GET_COMMITMENT_SELECTOR + challengeDateWord(dateStr) },
          'latest',
        ],
      }),
    });
    if (!res.ok) throw new Error('RPC HTTP ' + res.status);
    const body = await res.json();
    if (body.error) {
      // getCommitment reverts on an unknown date — surface that distinctly.
      throw new Error('contract call reverted: ' + (body.error.message || 'unknown commitment'));
    }
    const hex = (body.result || '').replace(/^0x/, '');
    if (hex.length < 6 * 64) throw new Error('short eth_call return');
    const word = (i) => '0x' + hex.slice(i * 64, (i + 1) * 64);
    return {
      challengeDate: word(0),
      inputMerkleRoot: word(1),
      resultMerkleRoot: word(2),
      algorithmId: word(3),
      effectiveDate: word(4),
      committedAt: word(5),
    };
  }

  /** Try each public RPC in order; first success wins. */
  async function getCommitment(dateStr) {
    let lastErr = null;
    for (const endpoint of RPC_ENDPOINTS) {
      try {
        return await rpcCall(endpoint, dateStr);
      } catch (e) {
        lastErr = e;
        if (String(e.message).includes('reverted')) throw e; // definitive answer
      }
    }
    throw new Error('all RPC endpoints failed: ' + (lastErr && lastErr.message));
  }

  return { getCommitment, CONTRACT, EXPLORER };
});
