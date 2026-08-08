# Security policy

## Reporting a vulnerability

Please do not publish exploit details, credentials, Telegram identifiers, or
production data in a public issue.

Use GitHub's **Report a vulnerability** flow to open a private security
advisory for this repository. Include the affected component, a minimal
reproduction, impact, and a suggested fix if you have one.

## Scope

Security reports are welcome for the Cloudflare Worker, Telegram webhook,
GitHub Actions workflows, D1 access patterns, dependency chain, and accidental
secret or personal-data disclosure.

The maintainer does not operate a public shared bot. Deployments created from
this repository are owned and secured by their operators.

The default application mode auto-registers people who discover an instance's
Telegram bot. Member histories and notification preferences are isolated;
instance-wide user enumeration and the EUR/USD conversion budget are owner-only.
Do not publish a live bot username unless this access model is intentional.

## If a secret is exposed

Do not merely delete it from the latest commit. Revoke or rotate the credential
at its provider first, then remove it from git history and any workflow logs or
artifacts that may contain it.
