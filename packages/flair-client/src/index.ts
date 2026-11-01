export { FlairClient, FlairError, MissingSigningKeyError, canonicalRelationshipId, encodeRecordId } from "./client.js";
export {
  loadPrivateKey,
  loadPrivateKeyBounded,
  loadPrivateKeyString,
  resolveKeyPath,
  signRequest,
  inspectKeyLookup,
  formatKeyLookup,
  keyPathCandidates,
  callTimeHomes,
  expandHomePrefix,
} from "./auth.js";
export type { KeyLookupState, KeyAuthMethod, HomeSources } from "./auth.js";
export type {
  FlairClientConfig,
  Memory,
  MemoryType,
  Durability,
  Visibility,
  HostSource,
  SoulEntry,
  SearchResult,
  SearchResponse,
  SearchOptions,
  TrustBlock,
  BootstrapResult,
  Relationship,
} from "./types.js";
