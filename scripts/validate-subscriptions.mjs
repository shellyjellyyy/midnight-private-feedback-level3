// Validates every wallet-sdk subscription document against the LIVE Preprod
// indexer schema via introspection. Reports every field the live schema does
// not define, and every argument type mismatch, per subscription.
const LIVE = "https://indexer.preprod.midnight.network/api/v4/graphql";

async function gql(query, variables) {
  const r = await fetch(LIVE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}

// Pull the full schema (types + all fields + arg types).
const schemaQuery = `
{
  __schema {
    queryType { name }
    subscriptionType { name }
    types { kind name fields { name type { ...TypeRef } args { name type { ...TypeRef } } } }
  }
}
fragment TypeRef on __Type {
  kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
`;
const data = await gql(schemaQuery);
const types = {};
for (const t of data.__schema.types) {
  if (t.fields) {
    types[t.name] = {
      fields: Object.fromEntries(t.fields.map((f) => [f.name, f])),
    };
  }
}
const typeNameOf = (tr) => (!tr ? "?" : tr.name ?? typeNameOf(tr.ofType));

const docs = [
  ["UnshieldedTransactions", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/UnshieldedTransactions.js")).UnshieldedTransactions],
  ["ShieldedTransactions", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/ShieldedTransactions.js")).ShieldedTransactions],
  ["DustGenerationEvents", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/DustGenerationEvents.js")).DustGenerationEvents],
  ["DustLedgerEvents", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/DustLedgerEvents.js")).DustLedgerEvents],
  ["DustNullifierTransactions", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/DustNullifierTransactions.js")).DustNullifierTransactions],
  ["DustLedgerEventTip", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/DustLedgerEventTip.js")).DustLedgerEventTip],
  ["ZswapEvents", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/ZswapEvents.js")).ZswapEvents],
  ["ZswapEventTip", (await import("../node_modules/@midnightntwrk/wallet-sdk-indexer-client/dist/graphql/subscriptions/ZswapEventTip.js")).ZswapEventTip],
];

const problems = [];

function walk(selectionSet, currentType, path, docName) {
  if (!selectionSet) return;
  for (const sel of selectionSet.selections) {
    if (sel.kind === "InlineFragment") {
      // Inline fragment on a concrete type: continues in that type.
      if (sel.typeCondition) {
        const fragType = sel.typeCondition.name.value;
        walk(sel.selectionSet, fragType, path + " → … on " + fragType, docName);
      } else {
        walk(sel.selectionSet, currentType, path, docName);
      }
      continue;
    }
    if (sel.kind !== "Field") continue;
    if (sel.name.value === "__typename") continue;
    const field = types[currentType]?.fields[sel.name.value];
    if (!field) {
      problems.push({ doc: docName, where: path, issue: `field "${sel.name.value}" NOT on ${currentType}` });
      continue;
    }
    // Argument validation: every supplied arg must exist on the live field.
    const liveArgs = new Set((field.args ?? []).map((a) => a.name));
    for (const arg of sel.arguments ?? []) {
      if (!liveArgs.has(arg.name.value)) {
        problems.push({ doc: docName, where: path, issue: `arg "${arg.name.value}" NOT on ${currentType}.${sel.name.value}` });
      }
    }
    // Recurse into composite field types.
    const ftName = typeNameOf(field.type);
    if (types[ftName]) walk(sel.selectionSet, ftName, path + "." + sel.name.value, docName);
  }
}

console.log("subscription root:", data.__schema.subscriptionType?.name);
for (const [name, sub] of docs) {
  const doc = sub.document;
  const op = doc.definitions.find((d) => d.kind === "OperationDefinition");
  if (!op || op.operation !== "subscription") {
    console.log(`${name}: (not a subscription document — skipping)`);
    continue;
  }
  const rootField = op.selectionSet.selections[0];
  const rootName = rootField.name.value;
  // The subscription root type on the live schema:
  const subRoot = data.__schema.subscriptionType.name;
  const field = types[subRoot]?.fields[rootName];
  if (!field) {
    problems.push({ doc: name, where: "root", issue: `root subscription field "${rootName}" NOT on ${subRoot}` });
    console.log(`${name}: root "${rootName}" MISSING on ${subRoot}`);
    continue;
  }
  // args
  const liveArgs = new Set((field.args ?? []).map((a) => a.name));
  for (const arg of rootField.arguments ?? []) {
    if (!liveArgs.has(arg.name.value)) {
      problems.push({ doc: name, where: "root", issue: `arg "${arg.name.value}" NOT on ${subRoot}.${rootName}` });
    }
  }
  const rt = typeNameOf(field.type);
  walk(rootField.selectionSet, rt, rootName, name);
  console.log(`${name}: checked (root ${rootName} -> ${rt})`);
}

console.log("\n==== MISMATCHES ====");
if (problems.length === 0) {
  console.log("none — every subscription document matches the live schema");
} else {
  for (const p of problems) console.log(`- [${p.doc}] ${p.where}: ${p.issue}`);
  console.log(`\nTOTAL: ${problems.length}`);
}
