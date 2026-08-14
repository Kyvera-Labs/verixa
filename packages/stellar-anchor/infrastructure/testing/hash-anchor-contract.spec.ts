import { hashAnchorContract } from "./contracts/hash-anchor.contract.js";
import { InMemoryHashAnchor } from "./in-memory-hash-anchor.js";

hashAnchorContract(() => new InMemoryHashAnchor());
