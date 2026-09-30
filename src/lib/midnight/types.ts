/** Shared types for the midnight integration layer. */

import type { StateValue } from "@midnight-ntwrk/compact-runtime";

/** Shape of the generated `participants` Merkle tree path entries. */
export type PathEntry = { sibling: { field: bigint }; goes_left: boolean };

/** Shape of the generated `MerkleTreePath<10, Bytes<32>>` witness result. */
export type MerklePath = { leaf: Uint8Array; path: PathEntry[] };

/** The projected public ledger of the feedback contract. */
export type { Ledger } from "../../../managed/feedback/contract/index.js";

/** Re-export for callers that want the raw public state value type. */
export type { StateValue };
