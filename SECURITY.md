# Security Policy

## Supported versions

Klebb is under active development. Security fixes land on the current
`main` branch. There are no LTS or backport branches.

| Version        | Supported          |
| -------------- | ------------------ |
| main (latest)  | :white_check_mark: |
| Older releases | :x:                |

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues.**

Open a private security advisory at
<https://github.com/Aristocles/klebb/security/advisories/new>, or email
the maintainer directly (contact details in the repo owner's GitHub
profile).

Include:

- A clear description of the vulnerability
- Steps to reproduce
- Your assessment of impact (data exposure, auth bypass, remote code
  execution, etc.)
- Any PoC code, logs, or screenshots

### What to expect

- Acknowledgement within 72 hours
- Initial assessment within 7 days
- Fix timeline depends on severity; critical issues (auth bypass,
  secret exposure) get priority

### What's in scope

- The webapp code in this repository
- The default manifest processing path
- The bearer-token authentication flow
- WebAuthn registration and verification flows

### What's out of scope

- Third-party dependencies (report upstream; we'll track the advisory)
- Your instance's operational security (reverse proxy config, TLS
  cert management, OS hardening). See [`docs/DEPLOY.md`](docs/DEPLOY.md)
  for hardening guidance.
- Social-engineering or physical-access attacks

## Disclosure policy

- We use coordinated disclosure. Once a fix is ready and released, we
  publish a security advisory naming the reporter (unless anonymity is
  requested).
- No bug bounty program.
