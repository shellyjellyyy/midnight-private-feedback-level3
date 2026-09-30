// Why: the stable stack's SubmissionError is constructed with { message:
// 'Transaction submission error', cause: err }, but when the Effect failure
// crosses Effect.runPromise the `cause` (and `_tag`) are NOT preserved on the
// rejected object — our top-level handler therefore logs a bare "Transaction
// submission error" with no reason (observed live runs 7/8, 2026-09-28).
// This patch embeds the inner error's tag/message into the message string so
// the real reason survives to the log. Behavior is unchanged otherwise.
//
// node_modules-local (lost on `npm install`) — re-run: node scripts/patch-submission-logging.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const target = new URL(
  '../node_modules/@midnight-ntwrk/wallet-sdk-capabilities/dist/submission/submissionService.js',
  import.meta.url,
);
const orig = new URL(
  '../node_modules/@midnight-ntwrk/wallet-sdk-capabilities/dist/submission/submissionService.js.orig',
  import.meta.url,
);

const OLD = "Effect.mapError((err) => new SubmissionError({ message: 'Transaction submission error', cause: err }))";
const NEW =
  'Effect.mapError((err) => new SubmissionError({ message: ' +
  "`Transaction submission error: ${err && typeof err === 'object' ? `${err._tag ?? ''} ${err.message ?? String(err)}` : String(err)}${err && err.cause && err.cause.message ? ` | cause: ${err.cause.message}` : ''}`" +
  ', cause: err }))';

let source;
if (existsSync(orig)) {
  source = readFileSync(orig, 'utf8'); // idempotent: always start from pristine
} else {
  source = readFileSync(target, 'utf8');
  writeFileSync(orig, source);
}

const count = source.split(OLD).length - 1;
if (count === 0) {
  if (source.includes(NEW.slice(0, 40))) {
    console.log('patch-submission-logging: already applied');
    process.exit(0);
  }
  console.error('patch-submission-logging: unexpected file contents — not the expected SDK source');
  process.exit(1);
}
if (count !== 2) {
  console.error(`patch-submission-logging: expected 2 sites, found ${count} — aborting`);
  process.exit(1);
}
writeFileSync(target, source.split(OLD).join(NEW));
console.log(`patch-submission-logging: patched ${count} sites`);
