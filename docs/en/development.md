# Development

[简体中文](../zh-CN/development.md) · [Contributing](../../CONTRIBUTING.md) · [Architecture](../architecture/README.md)

This guide describes the public 1.41.1 source baseline and its packaging adaptations. It is not a promise of production parity from one command. The easiest end-user entry is the [hosted browser note trial](getting-started.md).

## Prerequisites

- Node.js **22.13.0 or newer** and npm; use a supported Node 22 release for the canonical validation path.
- Python **3.11 or newer** for source Companion development and Python-dependent tests.
- Windows x64 and PowerShell 7 for the full Windows release/installer validation and `package:companion` workflow.
- Network access for npm packages and the fixed release assets required by build/release checks.

The web stack is React, TypeScript, Vite/vinext, the Sites Vite integration, and Cloudflare Workers/D1. Python Companion is a separate local service. The public history starts with a clean import; it does not include private development ancestry.

## Install dependencies

From your fork or the public repository:

```sh
git clone https://github.com/zthagyamin/zhixue.git
cd zhixue
npm ci
```

The lockfile is authoritative. Existing dependency warnings can appear during installation; report relevant warnings and failures rather than hiding them. Do not use an automatic breaking dependency upgrade to make an audit report disappear.

For the canonical Windows test environment, in PowerShell 7:

```powershell
python -m venv .venv
$env:PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
& $env:PYTHON -m pip install -r companion/requirements.txt
npm test
npm run test:python
```

`PYTHON` selects the interpreter used by Node test wrappers. Set it to the actual installed interpreter, not a display name. The installed Python must have the required dependencies; a successful `npm ci` does not install them.

On other systems, create a venv, install the same requirements, and point `PYTHON` to its interpreter. Related web/domain tests can be useful there, but a Linux/macOS run with platform skips is not equivalent to Windows installer acceptance.

## Downloaded assets are not Git source

The public checkout excludes the existing maintainer EXE/portable release files and the bundled runtime archive. The public preparation hooks before build/test retrieve the required fixed release artifacts using versioned URLs and verify their SHA-256 values; the EXE and portable ZIP together are approximately **27 MB**. They are build/check inputs, not a new open-source binary release or an installation action.

A network/download/hash failure must stop preparation. Do not delete assertions, replace the expected hash with the received one, or substitute an arbitrary binary. Keep downloaded files and generated output out of commits. The single download manifest is `src/infrastructure/downloads/index.mjs`; release asset locations and hashes are version-specific.

Companion packaging additionally needs the independent `companion/runtime-windows-x64.zip` matching `runtime-manifest.json`. A Python development venv does not replace that archive. Preparing or redistributing it requires the official upstream runtime and its dependencies, integrity checks, and applicable notices. See [third-party notices](../../THIRD_PARTY_NOTICES.md). The archive is deliberately not tracked in Git.

## Run the web development server

```sh
npm run dev
```

Use the local address printed by the server. Do not assume a fixed port or reuse a stale preview URL. The development middleware contains mock login behavior; it is for local development, not production authentication.

Account features default to disabled in `.env.example`. If configuring them, copy only documented variables into an ignored local environment file and understand the service prerequisites. Do not copy production tokens, database files, or a personal note folder into the checkout.

The current application expects Sites-supplied identity and configured D1 bindings. Local mock identity, a placeholder database binding, and a rendered page do not prove real account isolation, deployment, or two-device synchronization. Replacing the production identity/hosting adapter needs its own design and tests; there is no supported one-command provider-independent production setup in this beta.

For Companion source work, use `companion/requirements.txt`, its configuration templates, and the current [Companion guide](../../companion/README.md). Use a disposable synthetic source and separate data directory. The packaged launcher/installer path expects its bundled runtime; do not mistake a missing package runtime for a Python source defect.

## Validation commands

| Command | What it checks |
| --- | --- |
| `npm test` | Full architecture, release consistency, lint, type checking, production build, and Node regression chain. |
| `npm run test:node` | Node regressions alone; not a replacement for the full chain. |
| `npm run test:python` | Companion unittest suite through the selected Python interpreter. |
| `npm run architecture:check` | Layer/dependency constraints and controlled legacy budgets. |
| `npm run typecheck` | TypeScript checks. |
| `npm run lint` | Lint rules; report existing warnings separately from introduced errors. |
| `npm run build` | Production build and its asset preparation/output checks. |
| `npm run package:companion` | Windows package construction; requires independently prepared runtime input. |

Tests use synthetic materials and mock providers by default. Do not run paid AI calls or write personal grades just to make a check pass. Report the actual command, exit code, failures, skipped cases, and unverified browser/material paths. This guide contains no claim that your checkout has already passed these checks.

The public baseline fixture is tied to the initial imported source tree rather than inaccessible private commits. Baseline adaptation must preserve all behavioral assertions around evaluation, durable saves, cancellation, and recovery.

## Where changes belong

Use `src/domain` for pure rules, `src/application` for use cases/ports, `src/infrastructure` for adapters, and `src/features` for interactions. `app` and `worker` include routing, composition, and legacy compatibility entries. `companion/program-files.json` remains the single package/install file list. See [Contributing](../../CONTRIBUTING.md) before touching protocols, scheduling, persistence, or architecture budgets.

## Troubleshooting and release boundaries

- **Python missing:** set `PYTHON` and confirm that interpreter can import the requirements.
- **Release asset mismatch/offline:** inspect the fixed manifest and network result; preserve verification failure, rather than weakening checks.
- **Runtime archive missing:** source tests and binary packaging have different inputs. Prepare the official matching archive before installer checks that need it.
- **Account/AI unavailable:** inspect feature flags and service configuration; an account feature error is not evidence that local rules are broken.
- **Preview cannot connect:** verify the live server address and process; a successful build is not a running preview.

Merging code, deploying a website, publishing Companion, and installing it for a user are separate operations. Keep their identities and receipts separate; do not claim one from evidence of another. Report vulnerabilities according to [SECURITY.md](../../SECURITY.md).

