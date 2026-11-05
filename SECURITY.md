# Security Policy

## Reporting a vulnerability

Please do not open a public issue or pull request for security vulnerabilities.

Instead, report them privately through GitHub's security reporting workflow for this repository:

- Go to the repository's Security tab
- Select "Report a vulnerability"
- Include a clear description, affected version or commit, reproduction steps, impact, and any suggested remediation

If GitHub private reporting is unavailable, contact the maintainer directly via a verified channel and do not disclose the issue publicly until it has been triaged and patched.

## Supported versions

The project currently supports the following versions for security fixes:

- `main` branch: actively supported
- release tags: supported for the latest published release only

If a vulnerability is reported against an older release, we may provide guidance or a backport at the maintainers' discretion.

## Response expectations

We aim to acknowledge valid reports within 5 business days and provide an initial remediation plan or status update as soon as the issue is triaged.

## Disclosure policy

Please allow a reasonable time for a fix to be prepared before publishing details of a vulnerability. We ask reporters to keep the issue private until a patch is available and a coordinated disclosure plan is agreed.

## Best practices for contributors

- Keep dependencies updated and review security advisories for packages used in the project
- Do not commit secrets, credentials, or tokens to the repository
- Validate file uploads, API inputs, and remote URLs before use in the app or service
- Prefer private-by-default handling for internal data and generated media
