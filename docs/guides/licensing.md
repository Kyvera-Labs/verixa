# Licensing

Verixa is [MIT licensed](../../LICENSE) — chosen over the alternatives for
reasons specific to what this project is:

- **MIT vs. Apache-2.0**: Apache-2.0 adds an explicit patent grant and a
  notice-of-changes requirement, which mainly matters for large projects
  where patent litigation risk between contributors/users is realistic.
  Verixa is infrastructure meant to be read, forked, and embedded with as
  little friction as possible — MIT's shorter, simpler terms serve that
  better, at the cost of the explicit patent grant.
- **MIT vs. AGPL**: AGPL's copyleft (including its "network use counts as
  distribution" clause) would require anyone running a modified Verixa as a
  network service to release their modifications. That's a reasonable choice
  for projects that want to prevent proprietary SaaS forks, but it directly
  conflicts with Verixa's goal of being freely embeddable auth/identity
  infrastructure inside other people's (including commercial) products —
  copyleft would be a adoption blocker, not a protection, for that use case.

## SPDX headers

New source files don't currently carry per-file SPDX license headers
(`// SPDX-License-Identifier: MIT`) — with a single license covering the
whole repository via the root `LICENSE` file and every workspace package's
`package.json` `license` field, a per-file header would be redundant, not
informative. Reach for a per-file SPDX header only if a specific file's
license genuinely differs from the rest of the repo (e.g. adapting code from
a third-party source under a compatible-but-different license) — in that
case, add the header to that file and record the attribution in
[`NOTICE`](../../NOTICE).

## Third-party attributions

[`NOTICE`](../../NOTICE) records attributions for third-party code or assets
_copied into_ Verixa's own source. It does not list npm dependencies — those
carry their own licenses via `node_modules` and `pnpm-lock.yaml`, and are
never redistributed as part of this repository's source.
