import { organizationMembershipRepositoryContract } from "./contracts/organization-membership-repository.contract.js";
import { organizationRepositoryContract } from "./contracts/organization-repository.contract.js";
import { userRepositoryContract } from "./contracts/user-repository.contract.js";
import { InMemoryOrganizationMembershipRepository } from "./in-memory-organization-membership-repository.js";
import { InMemoryOrganizationRepository } from "./in-memory-organization-repository.js";
import { InMemoryUserRepository } from "./in-memory-user-repository.js";

userRepositoryContract(() => new InMemoryUserRepository());
organizationRepositoryContract(() => new InMemoryOrganizationRepository());
organizationMembershipRepositoryContract(() => new InMemoryOrganizationMembershipRepository());
