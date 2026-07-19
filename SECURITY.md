# Security policy

## Supported versions

Security fixes are provided for the latest published `0.x` release. Users
should upgrade to the newest patch version before reporting an issue that may
already be resolved.

| Version        | Supported |
| -------------- | --------- |
| Latest `0.x`   | Yes       |
| Older releases | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting form:

https://github.com/kbaghini/node-idb/security/advisories/new

Include:

- A clear description and impact assessment
- A minimal reproduction or proof of concept
- Affected versions and environment
- Any known mitigations
- Whether the issue is already public elsewhere

You should receive an acknowledgement within seven days. Please allow a
reasonable remediation and release window before public disclosure.

## Security scope

Reports are especially useful when they involve data corruption, unsafe SQL
construction, path traversal, prototype pollution, arbitrary file access,
transaction isolation, legacy migration, denial of service, or unintended
exposure of stored data.

`node-idb` does not provide authentication, authorization, encryption at rest,
network transport, or tenant isolation. Applications are responsible for those
controls and should enforce conservative input-size limits before calling the
package.
