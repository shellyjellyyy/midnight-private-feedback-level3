import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime-ledger8';

export type Witnesses<PS> = {
  participantSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  participantMerklePath(context: __compactRuntime.WitnessContext<Ledger, PS>,
                        leaf_0: Uint8Array): [PS, { leaf: Uint8Array,
                                                    path: { sibling: { field: bigint
                                                                     },
                                                            goes_left: boolean
                                                          }[]
                                                  }];
  feedbackRating(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  feedbackComment(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  adminSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  registerParticipant(context: __compactRuntime.CircuitContext<PS>,
                      leaf_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  setSurveyOpen(context: __compactRuntime.CircuitContext<PS>, isOpen_0: boolean): __compactRuntime.CircuitResults<PS, []>;
  submitFeedback(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  registerParticipant(context: __compactRuntime.CircuitContext<PS>,
                      leaf_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  setSurveyOpen(context: __compactRuntime.CircuitContext<PS>, isOpen_0: boolean): __compactRuntime.CircuitResults<PS, []>;
  submitFeedback(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  registerParticipant(context: __compactRuntime.CircuitContext<PS>,
                      leaf_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  setSurveyOpen(context: __compactRuntime.CircuitContext<PS>, isOpen_0: boolean): __compactRuntime.CircuitResults<PS, []>;
  submitFeedback(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  participants: {
    isFull(): boolean;
    checkRoot(rt_0: { field: bigint }): boolean;
    root(): __compactRuntime.MerkleTreeDigest;
    firstFree(): bigint;
    pathForLeaf(index_0: bigint, leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array>;
    findPathForLeaf(leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array> | undefined;
    history(): Iterator<__compactRuntime.MerkleTreeDigest>
  };
  readonly participantCount: bigint;
  usedNullifiers: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<[Uint8Array, boolean]>
  };
  readonly responseCount: bigint;
  readonly rating1: bigint;
  readonly rating2: bigint;
  readonly rating3: bigint;
  readonly rating4: bigint;
  readonly rating5: bigint;
  commentCommitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  readonly surveyOpen: boolean;
  readonly adminAddress: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               admin_0: Uint8Array): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
