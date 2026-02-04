# Sled Migration Steps

Complete guide for migrating Matrix bot encryption keys from Sled to SQLite storage.

## Overview

This migration tool extracts encryption keys from Sled-based Matrix crypto stores and uploads them to the Matrix server's key backup system. After migration, the bot can be updated to use SQLite storage and will automatically recover keys from the server backup when needed.

### Why Migrate?

- **Sled deprecation**: The `matrix-bot-sdk` has moved from Sled to SQLite for crypto storage
- **Better reliability**: SQLite is more widely supported and battle-tested
- **Seamless recovery**: Updated bots automatically recover keys from server backup on decryption failure

### What Gets Migrated?

- Megolm session keys (room encryption keys)
- The keys are uploaded to Matrix server-side key backup
- The bot's new SQLite store will recover keys automatically when needed

## Prerequisites

### Required Software

- **Node.js 18+**: For running the migration tool
- **Rust toolchain**: For building the key extractor and native crypto module
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```

### Building the Native Crypto Module

The `@matrix-org/matrix-sdk-crypto-nodejs` package requires a custom build to include the `importRoomKeys` method needed for key upload. The prebuilt binary from npm does NOT include this method.

**One-time setup:**

```bash
# Clone the custom SDK repository (if not already available)
cd /path/to/your/repos
git clone https://github.com/AmbivalentApe/matrix-rust-sdk-crypto-nodejs.git

# Build the native module (requires Rust)
cd matrix-rust-sdk-crypto-nodejs
npm run build

# This creates: matrix-sdk-crypto.darwin-arm64.node (or linux equivalent)
```

**After each `npm install` in sled-migration-tool:**

```bash
# npm install downloads a prebuilt binary that's missing importRoomKeys
# You must copy the custom-built binary:
cp /path/to/matrix-rust-sdk-crypto-nodejs/matrix-sdk-crypto.darwin-arm64.node \
   node_modules/@matrix-org/matrix-sdk-crypto-nodejs/

# Verify the method is available:
node -e "const { OlmMachine, UserId, DeviceId, StoreType } = require('@matrix-org/matrix-sdk-crypto-nodejs'); \
  OlmMachine.initialize(new UserId('@t:t'), new DeviceId('T'), '/tmp/test', '', StoreType.Sqlite) \
  .then(m => console.log('importRoomKeys:', typeof m.importRoomKeys))"
# Should output: importRoomKeys: function
```

### Required Access

- Bot's storage directory path
- Bot's access token
- Homeserver URL
- Account password (for device deletion step)

### Install the Tool

```bash
# Clone the repository
git clone https://github.com/ixofoundation/sled-migration-tool.git
cd sled-migration-tool

# Install dependencies
yarn install

# Build TypeScript
yarn run build
```

## Pre-Migration Checklist

Before starting the migration:

- [ ] **Stop the bot** - Ensure the bot is completely stopped
- [ ] **Document current state**:
  - Note the current device ID (from `bot-sdk.json`)
  - Note the homeserver URL
  - Count rooms with encryption enabled
- [ ] **Verify storage access** - Confirm you can read the storage directory
- [ ] **Have password ready** - You'll need the account password for device deletion
- [ ] **Prepare secure storage** - For the recovery key (password manager, encrypted drive)

## Migration Steps

### Step 1: Create Backup

Create a backup of the current crypto store before making any changes.

```bash
STORAGE_PATH=/path/to/bot/storage sled-migration-tool backup
```

**What it does:**
- Copies the Sled crypto store to a timestamped backup directory
- Creates checksums for integrity verification
- Saves metadata about the backup

**Output:**
- `migration-backup-YYYYMMDD-HHMMSS/` directory with all backed up files

### Step 2: Extract Keys

Extract encryption keys from the Sled store into a JSON file.

```bash
STORAGE_PATH=/path/to/bot/storage sled-migration-tool extract
```

**What it does:**
- Builds the Rust key extractor (first run only)
- Opens the Sled crypto store
- Exports all Megolm session keys to JSON

**Output:**
- `extracted-keys.json` - Contains all encryption keys (keep secure!)

#### Fault-Tolerant Extraction (for corrupted databases)

If extraction fails with errors like "leading sigil is incorrect or missing" or other deserialization errors, the database may have some corrupted entries. Use the `--skip-errors` flag to extract as many keys as possible while skipping corrupted ones:

```bash
# Run the key extractor directly with fault-tolerant mode
cd rust-key-extractor
./target/release/sled-key-extractor \
  --sled-path $CRYPTO_STORE_PATH/matrix-sdk-crypto \
  --output /path/to/extracted-keys.json \
  --skip-errors \
  --failed-output /path/to/failed-sessions.json \
  --verbose
```

**Fault-tolerant mode:**
- Iterates through each session individually instead of loading all at once
- Skips corrupted entries and continues with valid ones
- Logs progress every 1000 sessions
- Outputs details of failed sessions to a separate file for debugging

**When to use:**
- When standard extraction fails with deserialization errors
- For very large databases (80GB+) that may have disk corruption
- When recovering partial data is better than no data

**Output in fault-tolerant mode:**
- `extracted-keys.json` - Successfully extracted keys
- `failed-sessions.json` - Details of sessions that couldn't be extracted (index, key hex, error message)

**Example output:**
```
Mode: FAULT-TOLERANT (will skip corrupted entries)
Found existing store cipher, importing with passphrase
Found 15847 entries in inbound group sessions tree
Progress: 1000 sessions exported...
...
Session 7234: Failed to deserialize - leading sigil incorrect at column 888
...
Extraction complete: 15802 succeeded, 45 failed out of 15847 total
Failed sessions written to: /path/to/failed-sessions.json
Keys successfully exported to: /path/to/extracted-keys.json
Total keys exported: 15802
Total keys failed: 45
```

### Step 3: Enable Server Backup

Create a server-side key backup and generate the recovery key.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/path/to/bot/storage \
sled-migration-tool enable
```

**What it does:**
- Creates a new backup version on the Matrix server
- Generates a recovery key (base58 encoded)
- Saves recovery key to `recovery-key.txt`

**Output:**
- `recovery-key.txt` - **SAVE THIS SECURELY!**
- `backup-private-key.bin` - Private key for encryption
- `backup-public-key.txt` - Public key reference

**CRITICAL**: Copy and securely store the recovery key before proceeding!

### Step 4: Upload Keys

Upload the extracted keys to the server backup.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/path/to/bot/storage \
sled-migration-tool upload
```

**What it does:**
- Reads extracted keys from `extracted-keys.json`
- Encrypts each key with the backup public key
- Uploads to the server backup

**Output:**
- Progress indicator showing keys uploaded per room
- Final count of uploaded keys

### Step 5: Verify Backup

Verify that all keys were successfully uploaded.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/path/to/bot/storage \
sled-migration-tool verify
```

**What it does:**
- Fetches backup statistics from server
- Compares against extracted key count
- Reports any discrepancies

**Expected output:**
```
Backup verification:
  Server backup version: 1
  Keys in backup: 150
  Keys extracted: 150
  Status: COMPLETE
```

### Step 6: Delete Old Device

Delete the old device to force key re-sharing on next login.

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/path/to/bot/storage \
sled-migration-tool delete-device
```

**What it does:**
- Reads the old device ID from `bot-sdk.json`
- Prompts for account password
- Deletes the device from the Matrix server

**Interactive prompts:**
- Enter account password
- Confirm device ID to delete

For non-interactive use:
```bash
MIGRATION_PASSWORD=yourpassword \
MIGRATION_CONFIRM=OLDDEVICEID \
sled-migration-tool delete-device
```

### Step 7: Deploy Updated Bot

Deploy the updated bot version with SQLite crypto storage support.

The updated `matrix-bot-sdk` will:
1. Create a new device on first start
2. Initialize a fresh SQLite crypto store
3. Automatically fetch decryption keys from server backup when needed

**No manual key recovery step required** - the bot handles this automatically.

## Running All Steps Together

For steps 3-5, you can run them together:

```bash
HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_xxx \
STORAGE_PATH=/path/to/bot/storage \
sled-migration-tool all
```

This runs: `enable` -> `upload` -> `verify`

**Note**: Backup, extract, and delete must still be run separately.

## Local Testing

Before running the migration in production, test locally.

### Running Commands Locally

The `sled-migration-tool` command is only available globally after installation. For local development/testing, use one of these approaches from within the `sled-migration-tool` directory:

```bash
cd /path/to/sled-migration-tool

# Option 1: Use npx with the current directory (recommended)
STORAGE_PATH=./test-storage npx . backup

# Option 2: Use npm scripts
STORAGE_PATH=./test-storage npm run backup

# Option 3: Run node directly (after building with npm run build)
STORAGE_PATH=./test-storage node lib/index.js backup

# Option 4: Link globally, then use from anywhere
npm link
STORAGE_PATH=./test-storage sled-migration-tool backup
```

### Test with a Copy of Production Storage

```bash
# Copy production storage to a local test directory
mkdir -p ./test-storage
cp -r /path/to/production/storage/* ./test-storage/

# Run backup step (from sled-migration-tool directory)
STORAGE_PATH=./test-storage npx . backup

# Run extraction step
STORAGE_PATH=./test-storage npx . extract

# Verify extracted keys
cat extracted-keys.json | jq '.total_keys'
```

### Test Against a Test Matrix Account

```bash
# Create a test bot account and get its access token
# Then run the full migration against the test account

HOMESERVER_URL=https://matrix.example.com \
ACCESS_TOKEN=syt_test_token \
STORAGE_PATH=./test-storage \
npx . all

# Verify the backup was created
curl -s -H "Authorization: Bearer syt_test_token" \
  https://matrix.example.com/_matrix/client/v3/room_keys/version | jq
```

### Verify Key Count Matches

```bash
# Count keys in extracted file
jq '.total_keys' extracted-keys.json

# Count keys in server backup
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "$HOMESERVER_URL/_matrix/client/v3/room_keys/version" | jq '.count'
```

## Kubernetes Deployment

### Option 1: Run Migration Pod

```bash
# Scale down the bot
kubectl scale deployment state-bot --replicas=0

# Run migration pod with the bot's PVC
kubectl run migration --image=ghcr.io/ixofoundation/sled-migration-tool:latest \
  --env="HOMESERVER_URL=https://matrix.ixo.world" \
  --env="ACCESS_TOKEN=$BOT_TOKEN" \
  --env="STORAGE_PATH=/data" \
  --overrides='{
    "spec": {
      "volumes": [{
        "name": "storage",
        "persistentVolumeClaim": {"claimName": "state-bot-pvc"}
      }],
      "containers": [{
        "name": "migration",
        "volumeMounts": [{
          "name": "storage",
          "mountPath": "/data"
        }]
      }]
    }
  }' \
  --rm -it -- all

# SAVE THE RECOVERY KEY from the output!
```

### Option 2: Kubernetes Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: sled-migration
spec:
  template:
    spec:
      containers:
      - name: migration
        image: ghcr.io/ixofoundation/sled-migration-tool:latest
        args: ["all"]
        env:
        - name: HOMESERVER_URL
          value: "https://matrix.ixo.world"
        - name: ACCESS_TOKEN
          valueFrom:
            secretKeyRef:
              name: bot-secrets
              key: access-token
        - name: STORAGE_PATH
          value: "/data"
        volumeMounts:
        - name: storage
          mountPath: /data
      volumes:
      - name: storage
        persistentVolumeClaim:
          claimName: state-bot-pvc
      restartPolicy: Never
```

### After Migration

1. Update the bot deployment to use the new image with SQLite support
2. Remove or archive the old Sled storage if desired
3. Scale the bot back up: `kubectl scale deployment state-bot --replicas=1`

## Post-Migration Verification

After deploying the updated bot:

### 1. Check Bot Started Successfully

```bash
kubectl logs deployment/state-bot | grep -i "crypto\|sqlite\|backup"
```

Look for:
- "Using SQLite crypto store" or similar
- No errors about missing keys

### 2. Test Encrypted Messaging

Send a test message to an encrypted room the bot is in:
1. Send a message the bot should respond to
2. Verify the bot can read and respond
3. Check logs for any decryption errors

### 3. Verify Key Recovery Works

The bot should automatically fetch keys from backup when it encounters a message it can't decrypt. Check logs for:
```
Fetching key from backup for session ...
Successfully recovered key from backup
```

## Rollback Procedure

If the migration fails or the bot can't decrypt messages:

### 1. Stop the New Bot

```bash
kubectl scale deployment state-bot --replicas=0
```

### 2. Restore from Backup

```bash
# Find the backup directory
ls -la migration-backup-*/

# Restore the crypto store
cp -r migration-backup-YYYYMMDD-HHMMSS/crypto-store-sled/* /path/to/storage/encrypted/
```

### 3. Verify Checksums

```bash
cd migration-backup-YYYYMMDD-HHMMSS
sha256sum -c checksums.sha256
```

### 4. Redeploy Original Bot

Deploy the original bot version that uses Sled storage.

### 5. Manual Key Recovery (Last Resort)

If the bot still can't decrypt after restoring:

```bash
# Use the recovery key to manually restore keys
# This requires the recovery key you saved during migration
```

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
- Ensure the bot is stopped and not holding database locks
- Try: `ls -la $STORAGE_PATH/encrypted/`

### "No keys were extracted"

- The crypto store may be empty (new bot with no encryption history)
- The Sled store may be corrupted - try restoring from backup
- Check the output for specific error messages

### "leading sigil is incorrect or missing" or "Failed to retrieve inbound group sessions"

This error indicates corrupted session data in the Sled database. The "sigil" refers to Matrix identifier prefixes (e.g., `!` for room IDs, `@` for user IDs). When this error occurs, one or more session entries have invalid data.

**Solution: Use fault-tolerant extraction mode**

```bash
cd rust-key-extractor
./target/release/sled-key-extractor \
  --sled-path $CRYPTO_STORE_PATH/matrix-sdk-crypto \
  --output /migration/extracted-keys.json \
  --skip-errors \
  --failed-output /migration/failed-sessions.json \
  --verbose
```

This will:
- Skip corrupted entries instead of failing completely
- Extract all valid sessions (often 99%+ of the data)
- Log which sessions failed and why
- Save failed session details to a separate file

**Common causes:**
- Disk corruption or incomplete writes
- Version mismatches between SDK versions
- Very large databases (80GB+) with accumulated corruption over time

**After extraction:**
- Check `failed-sessions.json` to see how many sessions couldn't be recovered
- Most failed sessions are for old rooms you may no longer need
- Proceed with uploading the successfully extracted keys

### "Authentication failed"

- Verify `ACCESS_TOKEN` is correct and not expired
- Get a fresh token if needed
- Check `HOMESERVER_URL` is correct (https, no trailing slash)

### "Backup already exists"

The tool will prompt whether to create a new backup version. Options:
- Say 'y' to create a new backup (recommended)
- Set `FORCE_NEW_BACKUP=1` for non-interactive mode
- The old backup is not deleted

### "Device deletion failed"

- Ensure password is correct
- Check if the device ID matches what's in `bot-sdk.json`
- Try deleting the device manually via Element or another client

### "Bot can't decrypt messages after migration"

1. Check bot logs for specific error messages
2. Verify the server backup exists:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" $HOMESERVER/_matrix/client/v3/room_keys/version
   ```
3. Ensure the new bot has the `RECOVERY_KEY` environment variable set
4. Try restarting the bot to trigger key recovery

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `STORAGE_PATH` | Yes | Path to bot's storage directory |
| `HOMESERVER_URL` | For server ops | Matrix homeserver URL |
| `ACCESS_TOKEN` | For server ops | Bot's access token |
| `CRYPTO_STORE_PATH` | No | Override crypto store path (default: `STORAGE_PATH/encrypted`) |
| `MIGRATION_DIR` | No | Working directory for migration files (default: current directory) |
| `OLD_DEVICE_ID` | No | Device ID to delete (auto-detected from bot-sdk.json) |
| `MIGRATION_PASSWORD` | No | Account password for non-interactive device deletion |
| `MIGRATION_CONFIRM` | No | Device ID confirmation for non-interactive deletion |
| `FORCE_NEW_BACKUP` | No | Skip prompt when existing backup found |
| `FORCE_BACKUP` | No | Continue backup even if bot appears running |

## Files Generated

During migration, these files are created in `MIGRATION_DIR`:

| File | Description | Security |
|------|-------------|----------|
| `recovery-key.txt` | Recovery key for backup | **SAVE SECURELY, then delete** |
| `backup-private-key.bin` | Private encryption key | Keep for migration only |
| `backup-public-key.txt` | Public key reference | Safe to keep |
| `extracted-keys.json` | Extracted Megolm keys | **DELETE after upload** |
| `migration-state.json` | Migration progress tracking | Safe to keep |
| `migration-backup-*/` | Pre-migration backup | Keep until verified |

## Security Considerations

1. **Recovery Key**: The most sensitive artifact. Store in password manager or encrypted storage.
2. **Extracted Keys**: Contains all encryption keys in plain JSON. Delete after successful upload.
3. **Access Token**: Do not commit to version control. Use secrets management in K8s.
4. **Backup Files**: Keep until migration is verified, then securely delete.
