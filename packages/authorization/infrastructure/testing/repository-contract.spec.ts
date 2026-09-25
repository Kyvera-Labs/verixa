import { InMemoryPermissionRepository } from "../fakes/in-memory-permission-repository.js";
import { InMemoryRoleRepository } from "../fakes/in-memory-role-repository.js";

import { permissionRepositoryContract } from "./contracts/permission-repository.contract.js";
import { roleRepositoryContract } from "./contracts/role-repository.contract.js";

roleRepositoryContract(() => new InMemoryRoleRepository());
permissionRepositoryContract(() => new InMemoryPermissionRepository());
