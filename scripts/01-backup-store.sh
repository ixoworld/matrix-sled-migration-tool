#!/bin/bash
# 01-backup-store.sh
# Creates a backup of the current crypto store before migration
#
# This script should be run BEFORE any migration steps to ensure
# you have a rollback option if something goes wrong.
#
# Required environment variables:
#   STORAGE_PATH - Path to the bot's storage directory

set -euo pipefail

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configuration from environment
STORAGE_PATH="${STORAGE_PATH:-}"
CRYPTO_STORE_PATH="${CRYPTO_STORE_PATH:-${STORAGE_PATH}/encrypted}"
MIGRATION_DIR="${MIGRATION_DIR:-$(pwd)}"
BACKUP_DIR="${MIGRATION_DIR}/migration-backup-$(date +%Y%m%d-%H%M%S)"

echo "=============================================="
echo "Matrix Bot Crypto Store Backup"
echo "=============================================="
echo ""

# Check required environment variable
if [ -z "${STORAGE_PATH}" ]; then
    echo "ERROR: STORAGE_PATH environment variable is not set"
    echo ""
    echo "Usage:"
    echo "  STORAGE_PATH=/app/storage ./01-backup-store.sh"
    exit 1
fi

echo "Storage path: ${STORAGE_PATH}"
echo "Crypto store path: ${CRYPTO_STORE_PATH}"
echo "Backup directory: ${BACKUP_DIR}"
echo ""

# Verify the storage directory exists
if [ ! -d "${STORAGE_PATH}" ]; then
    echo "ERROR: Storage directory does not exist: ${STORAGE_PATH}"
    exit 1
fi

# Verify the crypto store exists
if [ ! -d "${CRYPTO_STORE_PATH}" ]; then
    echo "ERROR: Crypto store directory does not exist: ${CRYPTO_STORE_PATH}"
    echo "This suggests the bot has never been started or encryption is not enabled."
    exit 1
fi

# Check if bot is running (basic check) - only if not in container
if command -v pgrep > /dev/null 2>&1; then
    if pgrep -f "node.*matrix" > /dev/null 2>&1; then
        echo "WARNING: A Matrix bot process appears to be running!"
        echo "Please stop the bot before backing up to ensure data consistency."
        echo ""

        # Skip interactive prompt if FORCE_BACKUP is set
        if [ -z "${FORCE_BACKUP:-}" ]; then
            read -p "Do you want to continue anyway? (y/N): " confirm
            if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
                echo "Backup cancelled."
                exit 1
            fi
        else
            echo "FORCE_BACKUP is set, continuing anyway..."
        fi
    fi
fi

# Create backup directory
echo "Creating backup directory..."
mkdir -p "${BACKUP_DIR}"

# Backup the crypto store (Sled)
echo "Backing up crypto store..."
if [ -d "${CRYPTO_STORE_PATH}/matrix-sdk-crypto" ]; then
    cp -r "${CRYPTO_STORE_PATH}/matrix-sdk-crypto" "${BACKUP_DIR}/crypto-store-sled"
    echo "  - Copied matrix-sdk-crypto (Sled store)"
elif [ -d "${CRYPTO_STORE_PATH}" ]; then
    # The entire encrypted directory might be the Sled store
    cp -r "${CRYPTO_STORE_PATH}" "${BACKUP_DIR}/crypto-store-sled"
    echo "  - Copied encrypted directory"
fi

# Backup bot-sdk.json if it exists
if [ -f "${CRYPTO_STORE_PATH}/bot-sdk.json" ]; then
    cp "${CRYPTO_STORE_PATH}/bot-sdk.json" "${BACKUP_DIR}/bot-sdk.json"
    echo "  - Copied bot-sdk.json"
fi

# Backup main bot.json storage
if [ -f "${STORAGE_PATH}/bot.json" ]; then
    cp "${STORAGE_PATH}/bot.json" "${BACKUP_DIR}/bot.json"
    echo "  - Copied bot.json"
fi

# Create metadata file
cat > "${BACKUP_DIR}/backup-metadata.json" << EOF
{
    "backup_timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "backup_path": "${BACKUP_DIR}",
    "source_storage": "${STORAGE_PATH}",
    "source_crypto_store": "${CRYPTO_STORE_PATH}",
    "hostname": "$(hostname)",
    "user": "$(whoami)"
}
EOF
echo "  - Created backup-metadata.json"

# Calculate checksums
echo "Calculating checksums..."
cd "${BACKUP_DIR}"
if command -v sha256sum > /dev/null 2>&1; then
    find . -type f -exec sha256sum {} \; > checksums.sha256
elif command -v shasum > /dev/null 2>&1; then
    find . -type f -exec shasum -a 256 {} \; > checksums.sha256
else
    echo "WARNING: Neither sha256sum nor shasum found, skipping checksum generation"
fi

echo ""
echo "=============================================="
echo "Backup Complete!"
echo "=============================================="
echo ""
echo "Backup location: ${BACKUP_DIR}"
echo ""
echo "Contents:"
ls -la "${BACKUP_DIR}"
echo ""
echo "IMPORTANT: Store this backup securely. You will need it for rollback"
echo "if the migration fails."
echo ""
echo "Next step: Run 02-extract-keys.sh to extract encryption keys"
