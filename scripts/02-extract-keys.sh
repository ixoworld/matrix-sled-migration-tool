#!/bin/bash
# 02-extract-keys.sh
# Builds and runs the Rust key extractor to export Megolm session keys
#
# This script compiles the Rust tool and extracts all encryption keys
# from the Sled crypto store into a JSON file.
#
# Required environment variables:
#   STORAGE_PATH - Path to the bot's storage directory
#
# Optional environment variables:
#   CRYPTO_STORE_PATH - Path to the crypto store (default: STORAGE_PATH/encrypted)
#   MIGRATION_DIR - Working directory for migration files (default: current directory)

set -euo pipefail

# Script directory for relative paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_EXTRACTOR_DIR="${SCRIPT_DIR}/../rust-key-extractor"

# Configuration from environment
STORAGE_PATH="${STORAGE_PATH:-}"
CRYPTO_STORE_PATH="${CRYPTO_STORE_PATH:-${STORAGE_PATH}/encrypted}"
MIGRATION_DIR="${MIGRATION_DIR:-$(pwd)}"
OUTPUT_FILE="${MIGRATION_DIR}/extracted-keys.json"

echo "=============================================="
echo "Matrix Bot Key Extraction"
echo "=============================================="
echo ""

# Check required environment variable
if [ -z "${STORAGE_PATH}" ]; then
    echo "ERROR: STORAGE_PATH environment variable is not set"
    echo ""
    echo "Usage:"
    echo "  STORAGE_PATH=/app/storage ./02-extract-keys.sh"
    exit 1
fi

echo "Rust extractor: ${RUST_EXTRACTOR_DIR}"
echo "Crypto store: ${CRYPTO_STORE_PATH}"
echo "Output file: ${OUTPUT_FILE}"
echo ""

# Check for Rust toolchain
if ! command -v cargo > /dev/null 2>&1; then
    echo "ERROR: Rust/Cargo not found!"
    echo ""
    echo "Please install Rust first:"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo ""
    echo "Then restart your terminal and run this script again."
    exit 1
fi

echo "Rust version: $(rustc --version)"
echo "Cargo version: $(cargo --version)"
echo ""

# Verify the crypto store exists
if [ ! -d "${CRYPTO_STORE_PATH}" ]; then
    echo "ERROR: Crypto store directory does not exist: ${CRYPTO_STORE_PATH}"
    exit 1
fi

# Find the actual Sled store path
SLED_PATH=""
if [ -d "${CRYPTO_STORE_PATH}/matrix-sdk-crypto" ]; then
    SLED_PATH="${CRYPTO_STORE_PATH}/matrix-sdk-crypto"
elif [ -d "${CRYPTO_STORE_PATH}" ]; then
    # The encrypted directory itself might contain the Sled files
    # Check for typical Sled files (db, blobs, etc.)
    if ls "${CRYPTO_STORE_PATH}"/*.sled > /dev/null 2>&1 || \
       [ -d "${CRYPTO_STORE_PATH}/db" ] || \
       [ -f "${CRYPTO_STORE_PATH}/conf" ]; then
        SLED_PATH="${CRYPTO_STORE_PATH}"
    fi
fi

if [ -z "${SLED_PATH}" ]; then
    echo "ERROR: Could not locate Sled store in ${CRYPTO_STORE_PATH}"
    echo "Please check the crypto store path."
    exit 1
fi

echo "Found Sled store at: ${SLED_PATH}"
echo ""

# Convert to absolute paths before any directory changes
# This prevents issues when using relative paths like ./test-storage
SLED_PATH="$(cd "$(dirname "${SLED_PATH}")" && pwd)/$(basename "${SLED_PATH}")"
OUTPUT_FILE="$(cd "$(dirname "${OUTPUT_FILE}")" && pwd)/$(basename "${OUTPUT_FILE}")"

# Check if pre-built binary exists (for Docker usage)
if [ -x "/usr/local/bin/key-extractor" ]; then
    echo "Using pre-built key-extractor binary..."
    EXTRACTOR_BIN="/usr/local/bin/key-extractor"
else
    # Build the Rust extractor
    echo "Building Rust key extractor (this may take a while on first run)..."
    echo ""
    cd "${RUST_EXTRACTOR_DIR}"

    # Build in release mode for better performance
    cargo build --release 2>&1 | while IFS= read -r line; do
        echo "  $line"
    done

    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        echo ""
        echo "ERROR: Failed to build Rust extractor"
        exit 1
    fi

    echo ""
    echo "Build successful!"
    echo ""

    EXTRACTOR_BIN="${RUST_EXTRACTOR_DIR}/target/release/sled-key-extractor"
fi

# Run the extractor
echo "Extracting keys from Sled store..."
echo ""

"${EXTRACTOR_BIN}" \
    --sled-path "${SLED_PATH}" \
    --output "${OUTPUT_FILE}" \
    --verbose

if [ $? -ne 0 ]; then
    echo ""
    echo "ERROR: Key extraction failed"
    exit 1
fi

echo ""
echo "=============================================="
echo "Key Extraction Complete!"
echo "=============================================="
echo ""

# Show summary
if [ -f "${OUTPUT_FILE}" ]; then
    echo "Output file: ${OUTPUT_FILE}"
    echo "File size: $(ls -lh "${OUTPUT_FILE}" | awk '{print $5}')"
    echo ""

    # Try to show key count using jq if available
    if command -v jq > /dev/null 2>&1; then
        TOTAL_KEYS=$(jq '.total_keys' "${OUTPUT_FILE}")
        ROOM_COUNT=$(jq '.keys_by_room | keys | length' "${OUTPUT_FILE}")
        echo "Total keys extracted: ${TOTAL_KEYS}"
        echo "Rooms with keys: ${ROOM_COUNT}"
    else
        echo "(Install jq to see detailed statistics)"
    fi

    echo ""
    echo "IMPORTANT: The extracted keys file contains sensitive data!"
    echo "Do not share it or commit it to version control."
    echo ""
    echo "Next step: Run 'sled-migration-tool enable' to set up server backup"
else
    echo "WARNING: Output file was not created. Check the error messages above."
    exit 1
fi
