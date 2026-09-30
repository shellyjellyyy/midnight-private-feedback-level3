// Patch for the stable @midnight-ntwrk/wallet-sdk-node-client PolkadotNodeClient.
//
// ROOT-CAUSE FIX (permanent): `make()` does `await api.disconnect()` right
// after loading metadata, but WsProvider.disconnect() only INITIATES the
// WebSocket close handshake — `disconnect()` resolves before the close event
// fires (observed ~440 ms later on Preview). `Deferred` then releases the
// submit path, which sees the still-open socket (`isConnected === true`),
// issues `submitAndWatchExtrinsic` on it, and the late close event kills the
// subscription → "disconnected from wss://rpc.preview.midnight.network/:
// 1000:: Normal Closure" → SubmissionError. Observed live runs 6-10
// (2026-09-28); run 5 (submit 30 min after client creation) succeeded because
// the handshake had long finished. Fix: after api.disconnect(), wait (bounded)
// until the socket is actually closed before releasing the client.
//
// DIAGNOSTIC MARKERS ([PKT] logs + tx byte capture): temporary, kept while the
// live E2E flow is being debugged. Every broadcast transaction is written to
// logs/tx-capture/<epoch>.hex (public chain data only — exactly what is sent
// to the node; contains no private state/seeds) so a node-rejected tx can be
// deserialized and inspected after the fact. Remove before any submission by
// passing --no-diagnostics.
//
// node_modules-local (lost on `npm install`) — re-run:
//   node scripts/patch-node-client-logging.mjs [--revert] [--no-diagnostics]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const target = new URL(
  '../node_modules/@midnight-ntwrk/wallet-sdk-node-client/dist/effect/PolkadotNodeClient.js',
  import.meta.url,
);
const orig = new URL(
  '../node_modules/@midnight-ntwrk/wallet-sdk-node-client/dist/effect/PolkadotNodeClient.js.orig',
  import.meta.url,
);

const diagnostics = !process.argv.includes('--no-diagnostics');
const revertMode = process.argv.includes('--revert');

// Permanent race fix: wait for the metadata-connection close handshake to
// finish before the client is handed to the submit path.
const CLOSE_WAIT =
  '            await api.disconnect();\n' +
  '            let closeWaits = 0;\n' +
  '            while (api.isConnected && closeWaits < 150) {\n' +
  '                await new Promise((resolve) => setTimeout(resolve, 20));\n' +
  '                closeWaits++;\n' +
  '            }\n' +
  '            console.log(`[PKT] make: metadata disconnect fully closed after ${closeWaits * 20}ms (${new Date().toISOString()})`);';

// fs import used by the tx-capture diagnostic (ESM static import).
const FS_IMPORT =
  "import { u8aToHex } from '@polkadot/util'\nimport { mkdirSync, writeFileSync } from 'node:fs'";

// Byte capture at the moment the serialized tx is handed to the node.
const CAPTURE =
  '            try { mkdirSync(`${process.cwd()}/logs/tx-capture`, { recursive: true }); writeFileSync(`${process.cwd()}/logs/tx-capture/${Date.now()}.hex`, u8aToHex(serializedTransaction)); } catch (capErr) { console.log(`[PKT] tx capture failed: ${capErr && capErr.message}`); }';

const replacements = [
  // fs import for tx byte capture
  ["import { u8aToHex } from '@polkadot/util'", FS_IMPORT],
  // make(): metadata load + immediate disconnect + RACE FIX (wait for close)
  ['            await api.disconnect();', CLOSE_WAIT],
];

if (diagnostics) {
  replacements.push(
    // acquireRelease finalizer (scope close)
    [
      '(api) => Effect.promise(() => api.disconnect())',
      '(api) => Effect.promise(() => { console.log(`[PKT] client scope release disconnect (${new Date().toISOString()})`); return api.disconnect(); })',
    ],
    // ensureConnection entry
    [
      '    ensureConnection() {\n        return pipe(Effect.promise(async () => {',
      '    ensureConnection() {\n        console.log(`[PKT] ensureConnection enter, connected=${this.api.isConnected} (${new Date().toISOString()})`);\n        return pipe(Effect.promise(async () => {',
    ],
    // send initiation + byte capture
    [
      '            const unsubscribeP = this.api.tx.midnight',
      '            console.log(`[PKT] sendMnTransaction issuing (${new Date().toISOString()})`);\n' +
        CAPTURE +
        '\n            const unsubscribeP = this.api.tx.midnight',
    ],
    // send rejection (the path that produced our SubmissionError)
    [
      '                .catch((err) => {\n                return emit',
      '                .catch((err) => {\n                console.log(`[PKT] sendMnTransaction rejected: ${err && err.message} (${new Date().toISOString()})`);\n                return emit',
    ],
    // send stream teardown (local disconnect)
    [
      'Stream.ensuring(Effect.promise(() => this.api.disconnect()))',
      'Stream.ensuring(Effect.promise(() => { console.log(`[PKT] send stream ensuring disconnect (${new Date().toISOString()})`); return this.api.disconnect(); }))',
    ],
    // getGenesis teardown
    [
      'Effect.ensuring(Effect.promise(() => this.api.disconnect())));',
      'Effect.ensuring(Effect.promise(() => { console.log(`[PKT] getGenesis ensuring disconnect (${new Date().toISOString()})`); return this.api.disconnect(); })));',
    ],
  );
}

if (revertMode) {
  if (!existsSync(orig)) {
    console.error('patch-node-client-logging: no .orig backup to revert to');
    process.exit(1);
  }
  writeFileSync(target, readFileSync(orig, 'utf8'));
  console.log('patch-node-client-logging: reverted to pristine');
  process.exit(0);
}

let source;
if (existsSync(orig)) {
  source = readFileSync(orig, 'utf8'); // idempotent: always start from pristine
} else {
  source = readFileSync(target, 'utf8');
  writeFileSync(orig, source);
}

for (const [oldStr, newStr] of replacements) {
  const count = source.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`patch-node-client-logging: expected exactly 1 match, found ${count}: ${oldStr.slice(0, 60)}...`);
    process.exit(1);
  }
  source = source.replace(oldStr, newStr);
}
writeFileSync(target, source);
console.log(`patch-node-client-logging: applied (${replacements.length} replacements, diagnostics=${diagnostics})`);
