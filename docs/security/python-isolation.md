# Python execution security boundary

## Threat model and implementation

Learner programs, imported starter code and question `testCode` are untrusted programs. Counting assertions is a grading aid, not a sandbox. They must never execute in a Worker belonging to the application's origin.

`app/python-sandbox.ts` implements the existing worker-client interface with a hidden iframe using `sandbox="allow-scripts"` and no `allow-same-origin`. The shipped bridge creates an opaque-origin classic Worker and imports the pinned Pyodide modules inside it. Classic Workers are used for opaque-origin compatibility; this is not permission to relax sandbox flags or CSP. The runtime refuses to initialize without the bridge.

The iframe contains trusted bridge code only, not learner code. Its CSP denies network connections, nested frames, objects, forms and images. User programs stay in the Worker, so they do not receive a document or iframe navigation capability. Blob descendants inherit the restrictive policy. Overriding `fetch` alone is not the security boundary: browser CSP must also block native fetch, XHR and descendant-Worker requests.

The public bridge refuses bootstrap unless `self.origin === 'null'`; directly opening or embedding the file without sandboxing must not run a user-provided worker. Use the security origin, not `location.origin` of an `about:srcdoc` URL.

The initial `postMessage` targets the exact frame WindowProxy and transfers a private MessageChannel. The wildcard target origin is necessary for an opaque origin. The bridge checks the sender is its parent and handles bootstrap once. Programs are transferred as structured messages, never interpolated into the iframe HTML. Returned text is bounded; worker objects are not accepted as application data.

## Runtime asset broker

The host loads fixed local runtime files and accepts only exact wheel filenames from the trusted, pinned Pyodide lockfile. Wheel requests use a fixed versioned CDN root, omit credentials and referrers, reject redirects, and verify SHA-256. No arbitrary URLs, query parameters, headers, bodies, application endpoints, database access or credentials are exposed through the broker.

Limits: 48 MiB per asset, 128 MiB of downloaded assets per runtime, 32 distinct wheels, 128 broker requests. Existing code/input/output limits and execution/preparation timeouts remain enforced. Cancellation and timeouts destroy the iframe and terminate execution. Failures must never trigger a same-origin fallback.

General networking and arbitrary pip URLs from Python are intentionally unavailable. Built-in exercises and allowed Pyodide packages remain supported. This boundary is not a defense against browser-engine vulnerabilities, all resource-exhaustion attacks, or dishonest self-grading inside an attacker-controlled Python interpreter.

## Verification

`tests/python-sandbox.test.mjs` covers the broker's filename policy and wiring. `.github/security-python-browser.mjs` runs real Chromium and the pinned Pyodide against synthetic cookies, IndexedDB data and a local API probe. It checks ordinary Python/stdin/assertions, NumPy/pandas, forbidden storage and network access, descendant native fetch, unsandboxed bootstrap refusal, output limits, cancellation and timeout cleanup. Browser results are recorded with the tested commit; source review alone must not be called a successful browser test.

The security workflow also runs original Node regressions, lint, types, application build, a synthetic Drizzle schema-generation test, Semgrep, Trivy, Betterleaks and a pip audit of the exact Windows archive inventory. No production URL, real credential, user notebook or database is used. Raw secret candidates stay in disposable runner storage; reports retain digests, locations and explicit classifications, without broad suppression rules.

Scanner completion does not mean zero findings. Interpret remaining `exec` and opaque-origin wildcard-message reports using this boundary and browser evidence. Unsupported workflow parsing, platform-specific skips and untested browsers must remain disclosed. Python package auditing does not audit the embedded CPython binary itself. Review and deployment approval remain separate from this repair branch.
