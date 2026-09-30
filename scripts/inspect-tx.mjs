// Post-mortem inspector for captured Preview transactions (public chain data
// only — the exact bytes that were/would have been broadcast; contains no
// private state or seeds).
//
// Usage:
//   node scripts/inspect-tx.mjs <path-to-hex-file> [--depth N]
//
// Deserializes a finalized v8 transaction with the same stable ledger module
// the testkit uses and walks its structure (intents → contract actions →
// transcripts/ops, dust actions, offers) so ledger-level validation failures
// (e.g. "Invalid Transaction: Custom error: 117" = NotNormalized) can be
// attributed to one of the ledger's checks:
//   - dust.rs       empty dust actions (no spends AND no registrations)
//   - verify.rs     contract state maintenance_authority.counter != 0
//   - verify.rs     two consecutive Noop ops in a call transcript
//   - verify.rs     maintenance signature ordering / authority counter
import { readFileSync } from 'node:fs';

const hexFile = process.argv[2];
if (!hexFile) {
  console.error('usage: node scripts/inspect-tx.mjs <hex-file> [--depth N]');
  process.exit(1);
}
const maxDepth = (() => {
  const i = process.argv.indexOf('--depth');
  return i >= 0 ? Number(process.argv[i + 1]) : 14;
})();

// STABLE (v8-era) ledger module — same instance family as the testkit; the
// top-level midnight-js-protocol is the v9 stack and rejects `transaction[v9]`
// bytes (observed: header tag mismatch on deserialize).
const { Transaction } = await import(
  new URL(
    '../node_modules/@midnight-ntwrk/testkit-js-stable/node_modules/@midnight-ntwrk/midnight-js-protocol/dist/ledger.mjs',
    import.meta.url,
  )
);

const hex = readFileSync(hexFile, 'utf8').trim();
const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
console.log(`# ${hexFile}: ${bytes.length} bytes`);

let tx;
try {
  tx = Transaction.deserialize('signature', 'proof', 'binding', bytes);
  console.log('# stage: binding');
} catch (e) {
  console.error('deserialize(binding) failed:', e?.message ?? e);
  tx = Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
  console.log('# stage: pre-binding');
}

try {
  console.log('# identifiers:', JSON.stringify(tx.identifiers()));
} catch {
  /* identifiers may be unavailable pre-binding */
}

const SKIP = new Set(['constructor', '__destroy_into_raw', 'free', 'serialize', 'mockProve', 'eraseProofs', 'eraseSignatures', 'bind', 'prove', 'merge', 'addIntent', 'addCall', 'addDeploy', 'addZswapOffer', 'addMaintenanceUpdate', 'addCalls']);

function dataKeys(obj) {
  const out = [];
  for (let proto = obj; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (SKIP.has(k) || k === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, k);
      if (!desc) continue;
      if (typeof desc.get === 'function') out.push(k);
      else if (typeof desc.value === 'function' && desc.value.length === 0 && !/^__/.test(k)) out.push(k);
    }
  }
  for (const k of Object.keys(obj)) if (!out.includes(k)) out.push(k);
  return out;
}

function walk(value, depth, path) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const b = Buffer.from(value);
    const h = b.toString('hex');
    return b.length > 64 ? `0x${h.slice(0, 40)}…${h.slice(-12)} (${b.length}B)` : `0x${h}`;
  }
  if (typeof value === 'function') return `[function ${value.name}]`;
  if (depth >= maxDepth) return `[max depth at ${path}]`;
  if (value instanceof Map) {
    const out = {};
    let n = 0;
    for (const [k, v] of value) {
      if (++n > 20) {
        out['…'] = `${value.size} entries`;
        break;
      }
    out[String(k)] = walk(v, depth + 1, `${path}[${k}]`);
    }
    if (value.size === 0) return `[empty Map]`;
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((v, i) => walk(v, depth + 1, `${path}[${i}]`));
  }

  const keys = dataKeys(value).filter((k) => {
    try {
      return typeof value[k] !== 'function' || SKIP.has(k) === false;
    } catch {
      return false;
    }
  });

  const out = {};
  let any = false;
  for (const k of keys.slice(0, 50)) {
    try {
      let v = value[k];
      if (typeof v === 'function') v = v.call(value);
      out[k] = walk(v, depth + 1, `${path}.${k}`);
      any = true;
    } catch (e) {
      out[k] = `[error: ${e?.message ?? e}]`;
    }
  }
  if (!any) {
    // wasm-bindgen leaf: use toString (Op/Transcript/Commitment types render usefully)
    try {
      const s = String(value);
      if (s && s !== '[object Object]') return `${value.constructor?.name ?? 'obj'}: ${s.slice(0, 160)}`;
    } catch {
      /* ignore */
    }
    return `[${value.constructor?.name ?? 'object'}: no readable properties]`;
  }
  return out;
}

const shape = walk(tx, 0, 'tx');
const text = JSON.stringify(shape, null, 1);
console.log(text.length > 200000 ? text.slice(0, 200000) + '\n…[truncated]' : text);

// Focused NotNormalized probes on the walked structure:
const opSeq = [];
const collectOps = (node) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(collectOps);
  if (typeof node === 'string') return;
  for (const [k, v] of Object.entries(node)) {
    if (/^(program|ops)$/i.test(k) && Array.isArray(v)) {
      v.forEach((op, i) => opSeq.push({ path: `${k}[${i}]`, op: typeof op === 'string' ? op : JSON.stringify(op) }));
    } else collectOps(v);
  }
};
collectOps(shape);
if (opSeq.length) {
  console.log('\n# transcript op sequences:');
  for (let i = 1; i < opSeq.length; i++) {
    const a = opSeq[i - 1].op;
    const b = opSeq[i].op;
    if (/noop/i.test(a) && /noop/i.test(b)) console.log(`  !! CONSECUTIVE NOOP at ${opSeq[i].path}`);
  }
}
