# Local executor: stored-credential delivery (wire spec for the platform side)

Rule (Quinn): the server's core encryption key (Django SECRET_KEY, field-encryption key, anything that decrypts credentials at rest) NEVER leaves the server and is never a transport key.

Flow
1. MCP generates a fresh X25519 keypair per session; sends only `executor_public_key` (base64 SPKI DER) in `POST /api/v1/executors/sessions`, with `environment_id` / `credential_id` / `credential_role` when the call named them.
2. Server decrypts the stored credential with its own key as today, then immediately re-encrypts the password to `executor_public_key` and returns it in the create response as `credentials: [{label, username?, sealed}]`. Nothing plaintext, and nothing under the core key, enters a queue, response or log.
3. MCP opens `sealed` locally, keeps it in memory, and substitutes `{{cred:<label>}}` in fill/type/press. The brain only ever sees the placeholder.

Envelope `sealed`: `{v:1, alg:"x25519-hkdf-sha256-aes256gcm", epk, iv, ct, tag}` (base64). `epk` = sender's ephemeral X25519 public key (SPKI DER); key = HKDF-SHA256(ECDH shared secret, empty salt, info `debuggai-executor-credential-v1`, 32 bytes); AES-256-GCM, 12-byte iv, AAD = session id. Reference sealer: `sealTo()` in `services/localExecutor/credentialBox.ts`; tests in `__tests__/services/credentialBox.test.ts`.

Concurrency: `limits.max_inflight` is optional. Unset means the executor imposes no cap and runs whatever the brain sends in the order it arrives. If the backend sets it, the executor honours it.
