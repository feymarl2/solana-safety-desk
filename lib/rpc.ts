// Safety Desk — read-only devnet RPC access.
// Constructs a Connection to the public devnet RPC. Constructing a
// Connection performs NO network I/O, so this is safe to call anywhere;
// actual reads happen only in the check implementations (follow-up work).
// No wallet, no signer, no transactions — reads only, forever.

import { Connection } from "@solana/web3.js";
import { DEVNET_RPC_URL } from "./constants.js";

let shared: Connection | null = null;

/** Shared devnet Connection (lazy, offline-safe to construct). */
export function buildDevnetConnection(): Connection {
  if (!shared) {
    shared = new Connection(DEVNET_RPC_URL, "confirmed");
  }
  return shared;
}
