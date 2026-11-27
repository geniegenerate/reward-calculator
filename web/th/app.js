/**
 * th/app.js — page wiring for the Thai reward verifier.
 *
 * Same recomputation as the BSC page (recompute.js), a different anchor: the
 * Thai deployment holds no coin, so each day's record is an OpenTimestamps
 * stamp in Bitcoin, not a contract call (REWARD_SYSTEM v3.73).
 *
 *   1. You drop the input snapshot and the day's public record (the
 *      public-record JSON, or a bare .ots proof).
 *   2. The page recomputes both Merkle roots by running the published WASM.
 *   3. It rebuilds the stamped statement from the date, the roots it just
 *      computed and the binary's own hash, hashes it with SHA-256 and checks
 *      that this is the hash the proof stamps.
 *   4. It walks the proof to a Bitcoin block and asks two public explorers for
 *      that block's merkle root.
 * The page makes no request to the company. The statement inside a
 * public-record file is shown, never trusted: the check uses the one rebuilt
 * here.
 */
/* global keccak256, rewardMerkle, rewardRecompute, rewardOts */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { snapshot: null, result: null, proof: null, recordStatement: null, wasmBytes: null, wasmHash: null };

  function setStatus(id, kind, text) {
    const el = $(id);
    el.className = 'status ' + kind;
    el.textContent = text;
    el.hidden = false;
  }

  function hashRow(label, value, ok, variant) {
    const cls = (variant ? ' ' + variant : '') + (ok === undefined ? '' : ok ? ' ok' : ' bad');
    const mark = ok === undefined ? '' : ok ? ' ✓' : ' ✗';
    const code = document.createElement('code');
    code.className = 'hash';
    code.textContent = value; // values from dropped files are text, never markup
    return '<div class="hash-row' + cls + '"><span class="hash-label">' + label + mark + '</span>' + code.outerHTML + '</div>';
  }

  // ---- files -------------------------------------------------------------------

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function acceptProof(name, bytes) {
    const info = rewardOts.parse(bytes); // throws on anything that is not a proof
    state.proof = info;
    setStatus('record-status', 'ok', name + ' — หลักฐานประทับเวลา (sha256 ' + info.digest.slice(0, 12) + '…)');
  }

  function acceptJSON(name, doc) {
    if (doc && Array.isArray(doc.participants) && doc.pool && doc.input_merkle_root) {
      state.snapshot = doc;
      setStatus('snapshot-status', 'ok', name + ' — รอบวันที่ ' + doc.challenge_date + ', ผู้เข้าร่วม ' +
        doc.participants.length.toLocaleString() + ' คน');
    } else if (doc && Array.isArray(doc.participants) && doc.result_merkle_root) {
      state.result = doc;
      setStatus('result-status', 'ok', name + ' — ไฟล์ผลลัพธ์ (ใช้เทียบเพิ่มเติม)');
    } else if (doc && doc.method === 'opentimestamps' && doc.proof_ots_base64) {
      state.recordStatement = typeof doc.statement === 'string' ? doc.statement : null;
      acceptProof(name, base64ToBytes(doc.proof_ots_base64));
    } else if (doc && doc.method === 'opentimestamps') {
      setStatus('record-status', 'warn', name + ' — บันทึกนี้ยังไม่มีใบรับจากเซิร์ฟเวอร์ประทับเวลา ลองดาวน์โหลดใหม่ภายหลัง');
      return;
    } else {
      setStatus('snapshot-status', 'bad', name + ': ไม่ใช่ไฟล์ snapshot, ไฟล์ผลลัพธ์ หรือไฟล์บันทึกสาธารณะ');
      return;
    }
    maybeVerify();
  }

  async function onFiles(files) {
    for (const f of files) {
      try {
        if (f.name.endsWith('.wasm')) {
          await loadWasm(new Uint8Array(await f.arrayBuffer()), f.name + ' (ที่วางไว้)');
        } else if (f.name.endsWith('.ots')) {
          acceptProof(f.name, new Uint8Array(await f.arrayBuffer()));
          maybeVerify();
        } else {
          acceptJSON(f.name, JSON.parse(await f.text()));
        }
      } catch (e) {
        setStatus('snapshot-status', 'bad', f.name + ': ' + e.message);
      }
    }
  }

  async function loadWasm(bytes, origin) {
    state.wasmBytes = bytes;
    state.wasmHash = '0x' + keccak256(bytes);
    $('wasm-info').innerHTML = hashRow('keccak256(' + origin + ')', state.wasmHash) +
      '<p class="note">ค่านี้คือ algorithm_id ของโปรแกรมคำนวณ คอมไพล์ใหม่จาก ' +
      '<a href="https://github.com/geniegenerate/reward-calculator" rel="noopener">ซอร์สโค้ด</a> เพื่อยืนยันเองได้</p>';
    maybeVerify();
  }

  async function fetchBundledWasm() {
    try {
      const res = await fetch('../calculator/calculator.wasm');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await loadWasm(new Uint8Array(await res.arrayBuffer()), 'calculator.wasm');
    } catch (e) {
      setStatus('wasm-status', 'bad', 'โหลด calculator.wasm ไม่ได้: ' + e.message + ' — วางไฟล์ .wasm จาก GitHub release แทนได้');
    }
  }

  // ---- verify ------------------------------------------------------------------------

  let running = false;
  async function maybeVerify() {
    if (!state.snapshot || !state.wasmBytes || running) return;
    running = true;
    try {
      await verify();
    } catch (e) {
      setStatus('verdict', 'bad', 'ตรวจสอบไม่สำเร็จ: ' + e.message);
    } finally {
      running = false;
    }
  }

  async function verify() {
    const snap = state.snapshot;
    setStatus('verdict', 'busy', 'กำลังตรวจสอบ…');
    $('verify-detail').innerHTML = '';

    const algoOk = state.wasmHash === snap.algorithm_id;
    const { inputRoot, resultRoot, calcOut } = await rewardRecompute.run(snap, state.wasmBytes);
    const statement = rewardOts.distributionStatement(snap.challenge_date, inputRoot, resultRoot, state.wasmHash);
    const digest = rewardOts.toHex(rewardOts.sha256(new TextEncoder().encode(statement)));

    const rows = [
      hashRow('algorithm_id (โปรแกรมนี้)', state.wasmHash, algoOk),
      hashRow('input Merkle root (คำนวณซ้ำ)', inputRoot),
      hashRow('result Merkle root (คำนวณซ้ำ)', resultRoot),
      hashRow('sha256 ของข้อความที่สร้างใหม่', digest, state.proof ? digest === state.proof.digest : undefined),
    ];
    if (state.proof) rows.push(hashRow('sha256 ที่หลักฐานประทับไว้', state.proof.digest, undefined, 'chain'));
    if (state.result) {
      rows.push(hashRow('root ในไฟล์ผลลัพธ์', state.result.result_merkle_root, state.result.result_merkle_root === resultRoot));
    }

    let bitcoin = null;
    if (state.proof && digest === state.proof.digest) {
      bitcoin = await rewardOts.verifyBitcoin(state.proof, (u) => fetch(u));
      if (bitcoin.status === 'attested') {
        rows.push(hashRow('Bitcoin block', bitcoin.height + ' · ' + new Date(bitcoin.time * 1000).toISOString(), true, 'chain'));
      }
    }
    $('verify-detail').innerHTML = rows.join('');
    $('statement').textContent = statement;
    $('statement-box').hidden = false;
    $('rail-legend').hidden = false;
    if (state.recordStatement !== null && state.recordStatement !== statement) {
      rows.push(hashRow('ข้อความในไฟล์บันทึกไม่ตรงกับที่สร้างใหม่', '—', false));
      $('verify-detail').innerHTML = rows.join('');
    }

    setStatus.apply(null, verdict(snap, algoOk, digest, bitcoin));
    renderMembers(snap, calcOut);
  }

  function verdict(snap, algoOk, digest, bitcoin) {
    const day = snap.challenge_date;
    if (!algoOk) {
      return ['verdict', 'warn', 'โปรแกรมนี้ไม่ใช่รุ่นที่ใช้คำนวณรอบ ' + day +
        ' — ดาวน์โหลด calculator.wasm รุ่น ' + snap.algorithm_id.slice(0, 10) + '… จาก GitHub แล้ววางที่นี่'];
    }
    if (!state.proof) {
      return ['verdict', 'warn', 'คำนวณซ้ำบนเครื่องนี้แล้ว — วางไฟล์บันทึกสาธารณะของวันที่ ' + day + ' เพื่อเทียบกับ Bitcoin'];
    }
    if (digest !== state.proof.digest) {
      return ['verdict', 'bad', 'ไม่ตรงกัน — ค่าที่คำนวณซ้ำไม่ใช่ข้อความที่ถูกประทับเวลาไว้สำหรับวันที่ ' + day];
    }
    switch (bitcoin.status) {
      case 'attested':
        return ['verdict', 'ok', 'ยืนยันแล้ว — คำนวณซ้ำบนเครื่องนี้ ตรงกับบันทึกที่ประทับเวลาไว้ใน Bitcoin บล็อก ' +
          bitcoin.height + ' (' + new Date(bitcoin.time * 1000).toLocaleString('th-TH') + ')'];
      case 'pending':
        return ['verdict', 'warn', 'ตรงกับบันทึก แต่ Bitcoin ยังไม่ยืนยัน (ปกติภายในไม่กี่ชั่วโมง) — ดาวน์โหลดไฟล์บันทึกใหม่ภายหลังแล้วตรวจอีกครั้ง'];
      case 'mismatch':
        return ['verdict', 'bad', 'หลักฐานไม่ตรงกับบล็อก ' + bitcoin.height + ' ของ Bitcoin — ไฟล์บันทึกนี้ใช้ไม่ได้'];
      case 'unreachable':
        return ['verdict', 'warn', 'ตรงกับบันทึก แต่ติดต่อ Bitcoin explorer ไม่ได้ (' + bitcoin.error + ') — ลองอีกครั้ง หรือใช้คำสั่ง ots verify'];
      default:
        return ['verdict', 'warn', 'ไฟล์บันทึกนี้ไม่มีการยืนยันใน Bitcoin'];
    }
  }

  function renderMembers(snap, calcOut) {
    const byKey = new Map(snap.participants.map((p) => [p.ordering_key, p.pseudonym]));
    const rows = calcOut.members.map((m) => ({
      pseudonym: byKey.get(m.ordering_key) || '#' + m.ordering_key,
      credited: rewardMerkle.normalize6(m.credited_amount),
      loyalty: rewardMerkle.normalize6(m.loyalty_reward),
      newcomer: rewardMerkle.normalize6(m.newcomer_reward),
    }));
    $('members-section').hidden = false;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
    const render = (filter) => {
      const match = filter ? rows.filter((r) => r.pseudonym.toLowerCase().includes(filter.toLowerCase())) : rows;
      const shown = match.slice(0, 200);
      $('members-body').innerHTML = shown.map((r) =>
        '<tr><td>' + esc(r.pseudonym) + '</td><td class="num">' + esc(r.loyalty) + '</td><td class="num">' +
        esc(r.newcomer) + '</td><td class="num">' + esc(r.credited) + '</td></tr>').join('');
      $('members-count').textContent = shown.length === match.length
        ? match.length + ' คน'
        : 'แสดง ' + shown.length + ' จาก ' + match.length + ' คน — พิมพ์เพื่อกรอง';
    };
    $('members-filter').oninput = (e) => render(e.target.value.trim());
    render('');
  }

  window.addEventListener('DOMContentLoaded', () => {
    const drop = $('dropzone');
    const picker = $('file-picker');
    drop.addEventListener('click', () => picker.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') picker.click();
    });
    picker.addEventListener('change', () => onFiles([...picker.files]));
    ['dragover', 'dragenter'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));
    fetchBundledWasm();
  });
})();
