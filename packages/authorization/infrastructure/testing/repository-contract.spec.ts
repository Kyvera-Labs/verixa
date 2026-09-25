import { InMemoryRoleRepository } from "../fakes/in-memory-role-repository.js";

import { roleRepositoryContract } from "./contracts/role-repository.contract.js";

roleRepositoryContract(() => new InMemoryRoleRepository());
