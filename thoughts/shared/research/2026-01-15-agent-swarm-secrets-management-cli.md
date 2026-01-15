---
date: 2026-01-15T03:25:00Z
researcher: Researcher (Agent 16990304-76e4-4017-b991-f3e37b34cf73)
git_commit: N/A
branch: N/A
repository: N/A
topic: "CLI Tool for Agent Swarm Secrets Management (Password Manager for .env Files)"
tags: [research, secrets-management, cli, encryption, age, sops, vault, dotenv, agent-swarm]
status: complete
autonomy: critical
last_updated: 2026-01-15
last_updated_by: Researcher
---

# Research: CLI Tool for Agent Swarm Secrets Management

**Date**: 2026-01-15T03:25:00Z
**Researcher**: Researcher (Agent 16990304-76e4-4017-b991-f3e37b34cf73)
**Task ID**: 51b9ca47-3921-4c0b-a4f7-3bc449b15be6

## Research Question

Design a CLI tool for agent swarm secrets management that functions as a password manager for .env files. The tool should allow agents to securely store, query, and build .env files from a shared secret pool.

## Executive Summary

This research examines approaches for building a CLI-based secrets management tool optimized for agent swarm environments. The recommended architecture combines **age encryption** for simplicity and modern cryptography, **SOPS-inspired partial encryption** for git-friendly secret files, and **path-based organization** following HashiCorp Vault patterns. The tool should support multiple agents accessing a shared encrypted secret pool, with the ability to generate environment-specific .env files on demand.

---

## Detailed Findings

### 1. Encryption Approach: Age Over GPG

**Recommendation**: Use **age** (Actually Good Encryption) as the primary encryption layer.

#### Why Age?

| Aspect | Age | GPG |
|--------|-----|-----|
| **Philosophy** | Opinionated, secure defaults | Flexible, many options (can weaken security) |
| **Key Size** | Short, easy to backup (Bech32 encoded) | Long, complex |
| **Configuration** | Zero configuration needed | Extensive configuration possible |
| **Algorithms** | Fixed: X25519, ChaCha20-Poly1305, HKDF-SHA256 | User-selectable |
| **SSH Key Support** | Native | Requires gpg-agent configuration |

#### Age Cryptographic Details

- **File Key**: 128-bit symmetric key generated from CSPRNG, unique per file
- **Key Exchange**: X25519 for recipient encryption
- **Payload Encryption**: ChaCha20-Poly1305 with 64 KiB chunks (streaming capable)
- **Header MAC**: HMAC-SHA-256 for integrity verification

#### Key Format

```
# Private key (identity)
AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ

# Public key (recipient)
age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
```

#### Node.js/TypeScript Library

The official `age-encryption` npm package provides full TypeScript support:

```typescript
import * as age from "age-encryption"

// Generate key pair
const identity = await age.generateIdentity()
const recipient = await age.identityToRecipient(identity)

// Encrypt
const e = new age.Encrypter()
e.addRecipient(recipient)
const ciphertext = await e.encrypt("Secret data")

// Decrypt
const d = new age.Decrypter()
d.addIdentity(identity)
const plaintext = await d.decrypt(ciphertext, "text")
```

---

### 2. Secret Storage Architecture

**Recommendation**: Adopt SOPS-style partial encryption with path-based organization.

#### File-Based Storage Pattern

```
~/.swarm-secrets/
├── config.yaml                 # Tool configuration
├── identities/
│   ├── swarm.key              # Shared swarm identity (encrypted)
│   └── agent-{id}.key         # Per-agent identity (optional)
├── recipients/
│   └── swarm.pub              # All authorized recipients
└── secrets/
    ├── shared/
    │   ├── database.enc.yaml
    │   └── api-keys.enc.yaml
    ├── production/
    │   ├── webapp/
    │   │   └── config.enc.yaml
    │   └── api/
    │       └── config.enc.yaml
    └── staging/
        └── ...
```

#### Partial Encryption (SOPS Pattern)

Keys remain visible (for meaningful git diffs), only values are encrypted:

```yaml
# secrets/production/webapp/config.enc.yaml
database:
  host: ENC[AES256_GCM,data:db.example.com]
  port: 5432                              # Unencrypted (not sensitive)
  username: ENC[AES256_GCM,data:admin]
  password: ENC[AES256_GCM,data:s3cr3t]
api:
  stripe_key: ENC[AES256_GCM,data:sk_live_xxx]
sops:
  age:
    - recipient: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        ...
        -----END AGE ENCRYPTED FILE-----
  mac: ENC[AES256_GCM,data:...,tag:...]
```

#### Path-Based Organization (Vault Pattern)

```
/<environment>/<service>/<secret-group>
production/webapp/database
staging/api/stripe
shared/common/logging
```

---

### 3. Proposed CLI Interface

**Recommendation**: Use noun-verb command structure following modern CLI patterns.

#### Command Structure

```
swarm-secrets <noun> <verb> [path] [flags]
```

#### Core Commands

```bash
# Identity Management
swarm-secrets identity init                    # Generate new key pair
swarm-secrets identity export --public         # Export public key
swarm-secrets identity import <file>           # Import identity

# Secret Management
swarm-secrets secret set production/webapp/database \
  --key password --value "s3cr3t"              # Set single secret
swarm-secrets secret set production/webapp/database \
  --from-file credentials.yaml                 # Set from file
swarm-secrets secret get production/webapp/database  # Get all secrets
swarm-secrets secret get production/webapp/database \
  --key password                               # Get single secret
swarm-secrets secret list production/          # List secrets in path
swarm-secrets secret delete production/webapp/old   # Delete secret group

# Environment File Generation
swarm-secrets env build production/webapp      # Build .env to stdout
swarm-secrets env build production/webapp \
  --output .env                                # Write to file
swarm-secrets env build production/webapp \
  --format docker                              # Docker env-file format
swarm-secrets env build production/webapp staging/api \
  --merge                                      # Merge multiple paths

# Process Execution
swarm-secrets run production/webapp -- npm start  # Run with secrets injected
swarm-secrets run production/webapp \
  --env-file .env.template -- ./start.sh       # Template-based injection

# Sync (for shared storage)
swarm-secrets sync pull                        # Pull from remote
swarm-secrets sync push                        # Push to remote
```

#### Output Formats

| Format | Flag | Use Case |
|--------|------|----------|
| env | `--format env` | Standard .env (KEY="value") |
| env-no-quotes | `--format env-no-quotes` | Unquoted (KEY=value) |
| export | `--format export` | Shell export (export KEY="value") |
| json | `--format json` | Structured JSON |
| yaml | `--format yaml` | YAML format |
| docker | `--format docker` | Docker env-file |

#### Standard Flags

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-v, --version` | Show version |
| `-o, --output` | Output file path |
| `-f, --format` | Output format |
| `-q, --quiet` | Suppress output |
| `--no-input` | Disable interactive prompts |
| `--store` | Path to secret store |
| `--identity` | Path to identity file |

---

### 4. Agent Integration Patterns

#### Secret Pool Query Pattern

Agents query the shared pool and build environment-specific .env files:

```typescript
// Agent startup script
import { SwarmSecrets } from 'swarm-secrets';

const secrets = new SwarmSecrets({
  store: '/workspace/shared/.secrets',
  identity: process.env.SWARM_SECRETS_IDENTITY
});

// Build .env for this agent's service
const env = await secrets.buildEnv([
  'shared/common',           // Shared secrets
  'production/my-service',   // Service-specific
]);

// Write to file
await secrets.writeEnvFile(env, '/workspace/.env');

// Or inject directly
await secrets.run(['npm', 'start'], {
  paths: ['production/my-service']
});
```

#### Multi-Agent Access Control

```yaml
# config.yaml - Access control configuration
access:
  # All agents can read shared secrets
  shared/*:
    - "*"

  # Only specific agents can access production
  production/*:
    - "agent-leader-*"
    - "agent-deployer-*"

  # Staging accessible to all workers
  staging/*:
    - "agent-worker-*"
```

#### Environment Variable Injection

```bash
# Run command with secrets injected as env vars
swarm-secrets run production/webapp -- npm start

# Secrets available as:
# DATABASE_HOST=db.example.com
# DATABASE_PASSWORD=s3cr3t
# STRIPE_KEY=sk_live_xxx
```

---

### 5. Security Best Practices

#### Key Management

1. **Separate keys per environment**: Production keys should never be accessible from development
2. **Rotate keys regularly**: Implement key rotation schedule (30-90 days for high-risk secrets)
3. **Use hardware keys for production**: Consider age-plugin-yubikey for production identities
4. **Never commit private keys**: Add `*.key` to `.gitignore`

#### Secret Storage

1. **Encrypt at rest**: All secrets encrypted with age before storage
2. **Partial encryption**: Only values encrypted, keys visible for git diffs
3. **Integrity verification**: MAC on encrypted files prevents tampering
4. **Version history**: Git provides audit trail of secret changes

#### Runtime Security

1. **Memory safety**: Clear secrets from memory after use
2. **Process isolation**: Use process substitution to avoid disk writes
3. **Clipboard timeout**: Auto-clear clipboard after 30-60 seconds
4. **No CLI arguments for secrets**: Accept secrets via stdin or files only

#### Agent-Specific Considerations

1. **Ephemeral secrets**: Generate short-lived tokens where possible
2. **Least privilege**: Agents only access secrets they need
3. **Audit logging**: Log all secret access (not values)
4. **Revocation**: Ability to revoke agent access immediately

---

### 6. Existing Tools/Libraries to Leverage

#### Core Encryption

| Library | Use Case | NPM Package |
|---------|----------|-------------|
| age-encryption | Primary encryption | `age-encryption` |
| @noble/ciphers | ChaCha20-Poly1305 | `@noble/ciphers` |
| @noble/hashes | SHA-256, HKDF | `@noble/hashes` |

#### CLI Framework

| Library | Use Case | NPM Package |
|---------|----------|-------------|
| commander | Command parsing | `commander` |
| inquirer | Interactive prompts | `inquirer` |
| chalk | Terminal styling | `chalk` |
| ora | Progress spinners | `ora` |

#### File Handling

| Library | Use Case | NPM Package |
|---------|----------|-------------|
| yaml | YAML parsing | `yaml` |
| dotenv | .env parsing | `dotenv` |
| glob | File pattern matching | `glob` |

#### Inspiration from Existing Tools

| Tool | What to Learn |
|------|---------------|
| **SOPS** | Partial encryption, .sops.yaml configuration, multi-format support |
| **pass** | Unix philosophy, GPG integration, git sync |
| **gopass** | Multi-store (mounts), YAML structured secrets, team sharing |
| **Vault** | Path-based organization, policies, API design |
| **1Password CLI** | Secret references (`op://vault/item/field`), `op run` pattern |
| **Doppler** | Name transformers, environment hierarchy, `doppler run` |
| **Chamber** | AWS Parameter Store integration, `chamber exec` pattern |

---

### 7. Implementation Approach

#### Phase 1: Core Functionality

1. **Identity management**: Generate, import, export age keys
2. **Secret CRUD**: Set, get, list, delete encrypted secrets
3. **Basic .env generation**: Build .env from single path
4. **File-based storage**: Local encrypted YAML files

#### Phase 2: Agent Integration

1. **Multi-path merging**: Combine secrets from multiple paths
2. **Process execution**: `swarm-secrets run` with env injection
3. **TypeScript SDK**: Programmatic access for agents
4. **Path-based access control**: Restrict agent access by path patterns

#### Phase 3: Team/Swarm Features

1. **Remote sync**: Git-based or custom sync mechanism
2. **Key rotation**: Automated re-encryption with new keys
3. **Audit logging**: Track secret access
4. **Multiple stores**: Support multiple secret stores (like gopass mounts)

#### Phase 4: Advanced Features

1. **Secret templating**: Variable substitution in .env templates
2. **Dynamic secrets**: Integration with external secret sources
3. **Secret versioning**: Access previous versions of secrets
4. **Web UI**: Optional browser-based management interface

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Swarm Secrets CLI                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   CLI Tool   │    │  TypeScript  │    │   REST API   │       │
│  │  (swarm-se-  │    │     SDK      │    │  (optional)  │       │
│  │    crets)    │    │              │    │              │       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                   │                   │                │
│         └───────────────────┼───────────────────┘                │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Core Library                              ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  ││
│  │  │   Identity  │  │   Secret    │  │    Env Builder      │  ││
│  │  │   Manager   │  │   Store     │  │  (.env generation)  │  ││
│  │  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  ││
│  │         │                │                     │             ││
│  │         └────────────────┼─────────────────────┘             ││
│  │                          ▼                                   ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │              Age Encryption Layer                       │││
│  │  │  (X25519 key exchange, ChaCha20-Poly1305 encryption)   │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
│                             │                                    │
│                             ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Storage Layer                             ││
│  │  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐  ││
│  │  │ Local Files   │  │  Git Remote   │  │  External Store │  ││
│  │  │ (encrypted    │  │  (sync)       │  │  (Vault, S3,    │  ││
│  │  │  YAML/JSON)   │  │               │  │   etc.)         │  ││
│  │  └───────────────┘  └───────────────┘  └─────────────────┘  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

                         Agent Integration

┌─────────────────────────────────────────────────────────────────┐
│                        Agent Worker                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ // Agent startup                                            │ │
│  │ const secrets = new SwarmSecrets({...});                   │ │
│  │                                                             │ │
│  │ // Build .env from multiple paths                          │ │
│  │ await secrets.buildEnv([                                    │ │
│  │   'shared/common',                                          │ │
│  │   'production/my-service'                                   │ │
│  │ ]);                                                         │ │
│  │                                                             │ │
│  │ // Or run with secrets injected                            │ │
│  │ await secrets.run(['npm', 'start'], {                       │ │
│  │   paths: ['production/my-service']                          │ │
│  │ });                                                         │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Considerations Summary

| Risk | Mitigation |
|------|------------|
| Key exposure | Hardware keys (YubiKey), encrypted key files, never commit keys |
| Secret leakage in logs | Mask secrets in output, use `--quiet` in CI |
| Process visibility | Environment injection over file-based, clear memory after use |
| Git history exposure | Pre-commit hooks (gitleaks), encrypted values only |
| Unauthorized access | Path-based ACLs, agent identity verification |
| Key rotation | Automated re-encryption, key versioning |
| Audit trail | Git history, explicit access logging |

---

## Code References

### Key Libraries

- `age-encryption` npm package: https://www.npmjs.com/package/age-encryption
- FiloSottile/age GitHub: https://github.com/FiloSottile/age
- getsops/sops GitHub: https://github.com/getsops/sops
- Age TypeScript (typage): https://github.com/FiloSottile/typage

### Design Inspirations

- 1Password CLI: https://developer.1password.com/docs/cli/
- Bitwarden CLI: https://bitwarden.com/help/cli/
- Pass: https://www.passwordstore.org/
- Gopass: https://github.com/gopasspw/gopass
- Vault CLI: https://developer.hashicorp.com/vault/docs/commands
- Doppler CLI: https://docs.doppler.com/docs/cli
- Chamber: https://github.com/segmentio/chamber

---

## Open Questions

1. **Sync mechanism**: Should secrets sync via git (like pass/gopass) or a custom mechanism?
2. **Multi-tenancy**: How to handle multiple agent swarms with isolated secret pools?
3. **Secret versioning**: Should the tool maintain version history beyond git?
4. **External integrations**: Priority of integrations (AWS SM, Vault, etc.)?
5. **Web UI**: Is a web-based management interface needed for non-CLI users?

---

## Conclusion

The recommended approach for an agent swarm secrets management CLI combines:

1. **Age encryption** for modern, simple, secure cryptography
2. **SOPS-style partial encryption** for git-friendly secret files
3. **Vault-style path organization** for intuitive secret hierarchy
4. **1Password/Doppler-style `run` command** for seamless env injection
5. **TypeScript SDK** for programmatic agent integration

This architecture provides a balance of security, usability, and developer experience suitable for multi-agent environments where secrets need to be shared, versioned, and easily converted to .env files for application consumption.
