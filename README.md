# Matrix Sled Migration Tool

A CLI tool to migrate Matrix bot encryption keys from Sled storage to SQLite via server-side key backup.

## What This Tool Does

Matrix bots using the `matrix-bot-sdk` with end-to-end encryption store their encryption keys in a local database. Older versions used **Sled** (a Rust-based embedded database), while newer versions use **SQLite**.

This tool helps you migrate your bot's encryption keys from Sled to SQLite without losing the ability to decrypt old messages. It works by:

1. **Extracting** encryption keys from your Sled database
2. **Uploading** them to the Matrix server's key backup system
3. **Allowing** your bot (with the new SQLite storage) to recover the keys on first startup

## Quick Start

```bash
npx @ixo/matrix-sled-migration --help
```

## Prerequisites

- **Node.js 18+** - Required for running the tool
- **Rust toolchain** - Required for the `extract` step (compiles a Rust binary to read Sled)
  ```bash
  # Install Rust
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source ~/.cargo/env
  ```
- **Bot access token** - Your bot's Matrix access token
- **Bot storage directory** - Path to where your bot stores its data

## Installation

You can run the tool directly with `npx` (no installation required):

```bash
npx @ixo/matrix-sled-migration <command>
```

Or install globally:

```bash
npm install -g @ixo/matrix-sled-migration
matrix-sled-migration <command>
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `HOMESERVER_URL` | Matrix homeserver URL | `https://matrix.example.com` |
| `ACCESS_TOKEN` | Bot's access token | `syt_xxx...` |
| `STORAGE_PATH` | Path to bot's storage directory | `/app/storage` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `CRYPTO_STORE_PATH` | Path to crypto store | `STORAGE_PATH/encrypted` |
| `MIGRATION_DIR` | Directory for migration files | Current directory |
| `OLD_DEVICE_ID` | Device ID to delete | Auto-detected |
| `MIGRATION_PASSWORD` | Account password (non-interactive) | - |
| `MIGRATION_CONFIRM` | Confirm device deletion (non-interactive) | - |
| `FORCE_NEW_BACKUP` | Skip prompt when existing backup found | - |

## Commands

### Step-by-Step Migration

Run these commands in order:

#### 1. Backup (Optional but Recommended)

Create a backup of your crypto store before making any changes.

```bash
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration backup
```

#### 2. Extract Keys

Extract encryption keys from the Sled database. **Requires Rust toolchain.**

```bash
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration extract
```

This compiles a Rust binary and extracts keys to `extracted-keys.json`.

##### Fault-Tolerant Extraction (for corrupted databases)

If extraction fails with deserialization errors (e.g., "leading sigil is incorrect"), use the Rust extractor directly with fault-tolerant mode:

```bash
cd rust-key-extractor
./target/release/sled-key-extractor \
  --sled-path $STORAGE_PATH/encrypted/matrix-sdk-crypto \
  --output extracted-keys.json \
  --skip-errors \
  --failed-output failed-sessions.json \
  --verbose
```

This mode skips corrupted entries and extracts as many valid keys as possible.

#### 3. Enable Server Backup

Create a server-side key backup and generate a recovery key.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration enable
```

**IMPORTANT:** This step outputs a **recovery key**. Save it securely! It's the only way to recover your encryption keys.

#### 4. Upload Keys

Upload the extracted keys to the server backup.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration upload
```

#### 5. Verify Backup

Verify that all keys were uploaded successfully.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration verify
```

#### 6. Delete Old Device (Optional)

Delete the old device from the Matrix server. Requires your account password.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration delete
```

### Automated Migration

Run steps 3-5 in one command:

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/app/storage \
npx @ixo/matrix-sled-migration all
```

### Generate Recovery Key Only

For new deployments, generate a recovery key without migration:

```bash
npx @ixo/matrix-sled-migration generate-key
```

## Complete Migration Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                    MIGRATION WORKFLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. STOP YOUR BOT                                               │
│     └── Ensure no processes are accessing the storage           │
│                                                                  │
│  2. BACKUP (optional)                                           │
│     └── npx @ixo/matrix-sled-migration backup                   │
│                                                                  │
│  3. EXTRACT                                                     │
│     └── npx @ixo/matrix-sled-migration extract                  │
│     └── Requires: Rust toolchain                                │
│     └── Output: extracted-keys.json                             │
│                                                                  │
│  4. ENABLE + UPLOAD + VERIFY (or run "all")                     │
│     └── npx @ixo/matrix-sled-migration all                      │
│     └── Output: recovery-key.txt (SAVE THIS!)                   │
│                                                                  │
│  5. SAVE RECOVERY KEY                                           │
│     └── Store securely (password manager, encrypted backup)     │
│                                                                  │
│  6. DELETE OLD DEVICE (optional)                                │
│     └── npx @ixo/matrix-sled-migration delete                   │
│                                                                  │
│  7. UPDATE YOUR BOT                                             │
│     └── Deploy new version with SQLite crypto store             │
│     └── Configure with recovery key for key restoration         │
│                                                                  │
│  8. START YOUR BOT                                              │
│     └── Bot will restore keys from server backup                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Docker Usage

```bash
# Build
docker build -t matrix-sled-migration .

# Run
docker run -it --rm \
  -v /path/to/bot/storage:/data \
  -e HOMESERVER_URL=https://matrix.example.com \
  -e ACCESS_TOKEN=syt_xxx \
  -e STORAGE_PATH=/data \
  matrix-sled-migration all
```

## Kubernetes Usage

```bash
# Scale down the bot
kubectl scale deployment my-bot --replicas=0

# Run migration pod
kubectl run migration \
  --image=ghcr.io/ixoworld/matrix-sled-migration-tool:latest \
  --env="HOMESERVER_URL=https://matrix.example.com" \
  --env="ACCESS_TOKEN=$BOT_TOKEN" \
  --env="STORAGE_PATH=/data" \
  --overrides='{
    "spec": {
      "volumes": [{"name": "storage", "persistentVolumeClaim": {"claimName": "my-bot-pvc"}}],
      "containers": [{"name": "migration", "volumeMounts": [{"name": "storage", "mountPath": "/data"}]}]
    }
  }' \
  --rm -it -- all

# SAVE THE RECOVERY KEY!
# Then deploy updated bot with SQLite support
```

## Rust Key Extractor CLI

The `rust-key-extractor` binary can be run directly for more control:

```bash
./target/release/sled-key-extractor [OPTIONS] --sled-path <PATH> --output <FILE>
```

| Option | Description |
|--------|-------------|
| `-s, --sled-path <PATH>` | Path to the Sled crypto store directory |
| `-o, --output <FILE>` | Output file for extracted keys JSON |
| `-p, --passphrase <PASS>` | Store passphrase (default: empty string) |
| `-v, --verbose` | Enable verbose output |
| `--skip-errors` | **Fault-tolerant mode** - skip corrupted entries |
| `--failed-output <FILE>` | Output file for failed session details |

## Files Generated

| File | Description |
|------|-------------|
| `recovery-key.txt` | Recovery key - **SAVE THIS SECURELY!** |
| `backup-private-key.bin` | Private key for backup encryption |
| `backup-public-key.txt` | Public key for reference |
| `extracted-keys.json` | Keys extracted from Sled |
| `failed-sessions.json` | Failed sessions (when using `--skip-errors`) |
| `migration-state.json` | Migration progress tracking |

## Security

### Recovery Key

The recovery key is critical:

- It's the **only way** to recover your encryption keys
- Store it in a **password manager** or **encrypted backup**
- **Never** commit it to version control
- **Never** share it with anyone

### After Migration

After successful migration:

1. Delete `extracted-keys.json` (contains unencrypted keys)
2. Delete `backup-private-key.bin`
3. Keep `recovery-key.txt` in secure storage
4. Delete `migration-state.json`

## Troubleshooting

### "Rust/Cargo not found"

Install the Rust toolchain:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### "Failed to open Sled crypto store"

- Verify `STORAGE_PATH` points to the correct directory
- Check that the crypto store exists at `STORAGE_PATH/encrypted`
- Ensure the bot is stopped (not holding database locks)

### "No keys were extracted"

- The crypto store may be empty (new bot with no E2EE history)
- The Sled store may be corrupted

### "leading sigil is incorrect or missing" / "Failed to retrieve inbound group sessions"

The database has corrupted session entries. Use fault-tolerant extraction:

```bash
cd rust-key-extractor
./target/release/sled-key-extractor \
  --sled-path $STORAGE_PATH/encrypted/matrix-sdk-crypto \
  --output extracted-keys.json \
  --skip-errors \
  --verbose
```

This skips corrupted entries and extracts all valid keys. See `MIGRATION_STEPS.md` for details.

### "Authentication failed"

- Verify `ACCESS_TOKEN` is correct and not expired
- Check that `HOMESERVER_URL` is correct

### "Module not found" errors

Ensure you have Node.js 18+ installed:

```bash
node --version  # Should be v18.x.x or higher
```

## License

Apache-2.0
