#!/usr/bin/env npx ts-node
/**
 * store-backup-key-in-ssss.ts
 *
 * Reads the backup decryption key extracted from sled by the Rust key extractor
 * and stores it in Matrix SSSS (Secret Storage) under m.megolm_backup.v1.
 *
 * This is needed when resetKeyBackup() created a server backup but did NOT
 * store the backup key in SSSS. After running this command, extract-backup-key
 * will be able to retrieve the key from SSSS.
 *
 * Requires:
 *   - backup-key.json in MIGRATION_DIR (output by key-extractor --backup-key-output)
 *   - RECOVERY_PHRASE environment variable
 */

import * as fs from 'fs';
import * as path from 'path';
import { BackupDecryptionKey } from '@ixo/matrix-sdk-crypto-nodejs';
import { config, saveMigrationState, validateConfig } from '../config';
import {
    whoami,
    getBackupVersion,
    getAccountData,
    setAccountData,
    MatrixApiConfig,
} from '../utils/matrix-api';
import {
    deriveSSSSKeyFromPassphrase,
    verifySSSSKey,
    encryptAESSecretStorageItem,
    extractBackupKeyFromSSS,
} from '../utils/ssss';

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
};

function log(message: string): void {
    console.log(message);
}

function logError(message: string): void {
    console.error(`${colors.red}ERROR: ${message}${colors.reset}`);
}

function logSuccess(message: string): void {
    console.log(`${colors.green}${message}${colors.reset}`);
}

function logImportant(message: string): void {
    console.log(`${colors.bold}${colors.cyan}${message}${colors.reset}`);
}

/**
 * Base58 encoding (same as extract-backup-key.ts)
 */
function encodeBase58(buffer: Buffer): string {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + buffer.toString('hex'));
    let result = '';

    while (num > 0) {
        const remainder = Number(num % BigInt(58));
        result = alphabet[remainder] + result;
        num = num / BigInt(58);
    }

    // Add leading zeros
    for (const byte of buffer) {
        if (byte === 0) {
            result = '1' + result;
        } else {
            break;
        }
    }

    return result;
}

/**
 * Convert a Base64 backup key to the Matrix Base58 recovery key format.
 */
function backupKeyToRecoveryKey(backupKeyBase64: string): string {
    const seed = Buffer.from(backupKeyBase64, 'base64');

    const withoutParity = Buffer.concat([
        Buffer.from([0x8b, 0x01]),
        seed,
    ]);

    let parity = 0;
    for (const byte of withoutParity) {
        parity ^= byte;
    }

    const recoveryKeyBytes = Buffer.concat([withoutParity, Buffer.from([parity])]);
    const recoveryKey = encodeBase58(recoveryKeyBytes);

    return recoveryKey.match(/.{1,4}/g)?.join(' ') || recoveryKey;
}

interface SSSSKeyInfo {
    name?: string;
    algorithm: string;
    iv?: string;
    mac?: string;
    passphrase?: {
        algorithm: string;
        iterations: number;
        salt: string;
        bits?: number;
    };
}

export async function runStoreBackupKeyInSSSS(): Promise<void> {
    log('==============================================');
    log('Store Backup Key in SSSS (Oracle Migration)');
    log('==============================================');
    log('');

    // Validate configuration
    try {
        validateConfig();
    } catch (e) {
        logError((e as Error).message);
        process.exit(1);
    }

    // Check for recovery phrase
    const recoveryPhrase = process.env.RECOVERY_PHRASE;
    if (!recoveryPhrase) {
        logError('RECOVERY_PHRASE environment variable is required for this command.');
        log('');
        log('This is the MATRIX_RECOVERY_PHRASE used by the oracle to set up SSSS.');
        process.exit(1);
    }

    // Read backup key from file
    const backupKeyPath = path.join(config.migrationDir, 'backup-key.json');
    log(`Reading backup key from: ${backupKeyPath}`);

    if (!fs.existsSync(backupKeyPath)) {
        logError(`Backup key file not found: ${backupKeyPath}`);
        log('');
        log('Run the key extractor with --backup-key-output first:');
        log('  key-extractor --sled-path <path> --output extracted-keys.json --backup-key-output backup-key.json');
        process.exit(1);
    }

    let backupKeyData: { backup_key_base64: string; backup_version: string | null };
    try {
        backupKeyData = JSON.parse(fs.readFileSync(backupKeyPath, 'utf-8'));
    } catch (e) {
        logError(`Failed to parse backup key file: ${(e as Error).message}`);
        process.exit(1);
    }

    const backupKeyBase64 = backupKeyData.backup_key_base64;
    if (!backupKeyBase64) {
        logError('backup_key_base64 field is missing from backup-key.json');
        process.exit(1);
    }

    log(`  Backup key loaded (${Buffer.from(backupKeyBase64, 'base64').length} bytes)`);

    const apiConfig: MatrixApiConfig = {
        homeserverUrl: config.homeserverUrl,
        accessToken: config.accessToken,
    };

    // Get user ID
    log('');
    log('Fetching user information...');
    let userId: string;
    try {
        userId = await whoami(apiConfig);
        log(`  User ID: ${userId}`);
        saveMigrationState({ userId });
    } catch (e) {
        logError(`Failed to get user ID: ${(e as Error).message}`);
        process.exit(1);
    }

    // Verify server backup exists
    log('');
    log('Checking for existing backup on server...');
    const backupInfo = await getBackupVersion(apiConfig);

    if (!backupInfo) {
        logError('No backup found on server. This command requires an existing server backup.');
        process.exit(1);
    }

    log(`  Backup version: ${backupInfo.version}`);
    log(`  Algorithm: ${backupInfo.algorithm}`);
    log(`  Key count: ${backupInfo.count}`);

    // Verify extracted key matches server backup
    log('');
    log('Verifying extracted key matches server backup...');

    try {
        const decryptionKey = BackupDecryptionKey.fromBase64(backupKeyBase64);
        const derivedPublicKey = decryptionKey.megolmV1PublicKey.publicKeyBase64;
        const serverPublicKey = backupInfo.auth_data.public_key;

        if (derivedPublicKey === serverPublicKey) {
            logSuccess('  Key matches server backup public key!');
        } else {
            logError('Extracted key does NOT match server backup!');
            log(`  Expected public key: ${serverPublicKey}`);
            log(`  Got public key:      ${derivedPublicKey}`);
            process.exit(1);
        }
    } catch (e) {
        logError(`Failed to verify key: ${(e as Error).message}`);
        process.exit(1);
    }

    // Get SSSS key info
    log('');
    log('Fetching SSSS configuration...');

    const defaultKeyData = await getAccountData(apiConfig, userId, 'm.secret_storage.default_key');
    if (!defaultKeyData || !defaultKeyData.key) {
        logError('SSSS (Secret Storage) is not set up for this user.');
        log('The oracle must have completed initial setup (cross-signing + SSSS).');
        process.exit(1);
    }
    const keyId: string = defaultKeyData.key;
    log(`  SSSS default key ID: ${keyId}`);

    const keyInfo: SSSSKeyInfo | null = await getAccountData(
        apiConfig,
        userId,
        `m.secret_storage.key.${keyId}`,
    );
    if (!keyInfo) {
        logError(`SSSS key metadata not found for key ID: ${keyId}`);
        process.exit(1);
    }

    if (keyInfo.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
        logError(`Unsupported SSSS algorithm: ${keyInfo.algorithm}`);
        process.exit(1);
    }

    if (!keyInfo.passphrase || keyInfo.passphrase.algorithm !== 'm.pbkdf2') {
        logError('SSSS key is not passphrase-based. Cannot derive from recovery phrase.');
        process.exit(1);
    }

    log(`  SSSS algorithm: ${keyInfo.algorithm}`);
    log(`  PBKDF2 iterations: ${keyInfo.passphrase.iterations}`);

    // Derive SSSS master key
    log('');
    log('Deriving SSSS key from recovery phrase (PBKDF2, this may take a moment)...');

    const masterKey = await deriveSSSSKeyFromPassphrase(
        recoveryPhrase,
        keyInfo.passphrase.salt,
        keyInfo.passphrase.iterations,
        keyInfo.passphrase.bits || 256,
    );

    // Verify SSSS key
    const keyValid = await verifySSSSKey(masterKey, keyInfo as any);
    if (!keyValid) {
        logError('SSSS key verification failed: recovery phrase does not match');
        process.exit(1);
    }
    logSuccess('  SSSS key verified!');

    // Check if backup key is already in SSSS
    log('');
    log('Checking if backup key already exists in SSSS...');
    const existingBackupSecret = await getAccountData(apiConfig, userId, 'm.megolm_backup.v1');
    if (existingBackupSecret?.encrypted?.[keyId]) {
        log(`  ${colors.yellow}Backup key already exists in SSSS. Will overwrite.${colors.reset}`);
    } else {
        log('  No backup key in SSSS yet. Will store it now.');
    }

    // Encrypt backup key with SSSS
    log('');
    log('Encrypting backup key with SSSS...');

    const encryptedData = await encryptAESSecretStorageItem(
        backupKeyBase64,
        masterKey,
        'm.megolm_backup.v1',
    );

    // Store in account data
    log('Storing encrypted backup key in m.megolm_backup.v1 account data...');

    const accountData = {
        encrypted: {
            [keyId]: encryptedData,
        },
    };

    try {
        await setAccountData(apiConfig, userId, 'm.megolm_backup.v1', accountData);
        logSuccess('  Backup key stored in SSSS!');
    } catch (e) {
        logError(`Failed to store backup key in SSSS: ${(e as Error).message}`);
        process.exit(1);
    }

    // Verify round-trip
    log('');
    log('Verifying round-trip (extracting key back from SSSS)...');

    try {
        const roundTripKey = await extractBackupKeyFromSSS(apiConfig, userId, recoveryPhrase);
        if (roundTripKey === backupKeyBase64) {
            logSuccess('  Round-trip verification passed!');
        } else {
            logError('Round-trip verification FAILED! Extracted key does not match.');
            log(`  Original:  ${backupKeyBase64}`);
            log(`  Retrieved: ${roundTripKey}`);
            process.exit(1);
        }
    } catch (e) {
        logError(`Round-trip verification failed: ${(e as Error).message}`);
        process.exit(1);
    }

    // Save recovery files (same as extract-backup-key.ts)
    const recoveryKey = backupKeyToRecoveryKey(backupKeyBase64);
    const seed = Buffer.from(backupKeyBase64, 'base64');

    const recoveryKeyPath = config.recoveryKeyPath;
    log('');
    log(`Saving recovery key to: ${recoveryKeyPath}`);

    try {
        const dir = path.dirname(recoveryKeyPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const recoveryFileContent = `Matrix Key Backup Recovery Key (Stored in SSSS)
================================

User ID: ${userId}
Backup Version: ${backupInfo.version}
Stored: ${new Date().toISOString()}
Source: Extracted from sled, stored in SSSS

RECOVERY KEY:
${recoveryKey}

BASE64 KEY:
${backupKeyBase64}

================================
IMPORTANT: This key is now stored in SSSS (Secret Storage).
The oracle can extract it using MATRIX_RECOVERY_PHRASE.
================================
`;

        fs.writeFileSync(recoveryKeyPath, recoveryFileContent, { mode: 0o600 });
        logSuccess('  Recovery key saved!');
    } catch (e) {
        logError(`Failed to save recovery key: ${(e as Error).message}`);
    }

    // Save private key binary
    const privateKeyPath = path.join(path.dirname(recoveryKeyPath), 'backup-private-key.bin');
    fs.writeFileSync(privateKeyPath, seed, { mode: 0o600 });
    log(`  Private key saved to: ${privateKeyPath}`);

    // Save public key
    const decryptionKey = BackupDecryptionKey.fromBase64(backupKeyBase64);
    const publicKey = decryptionKey.megolmV1PublicKey.publicKeyBase64;
    const publicKeyPath = path.join(path.dirname(recoveryKeyPath), 'backup-public-key.txt');
    fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });
    log(`  Public key saved to: ${publicKeyPath}`);

    // Update migration state
    saveMigrationState({ backupVersion: backupInfo.version });

    // Summary
    log('');
    log('==============================================');
    logSuccess('Backup Key Stored in SSSS Successfully!');
    log('==============================================');
    log('');
    log(`Backup Version: ${backupInfo.version}`);
    log(`Recovery Key File: ${recoveryKeyPath}`);
    log('');
    log('Recovery Key (Base58):');
    logImportant(recoveryKey);
    log('');
    log('Recovery Key (Base64):');
    logImportant(backupKeyBase64);
    log('');
    log('The backup key is now stored in SSSS. The oracle can extract it');
    log('using MATRIX_RECOVERY_PHRASE on startup.');
    log('');
    log('Next step: Run `upload` to upload extracted keys to the server backup');
}

// Allow running directly
if (require.main === module) {
    runStoreBackupKeyInSSSS().catch((e) => {
        console.error(`${colors.red}ERROR: Unexpected error: ${e.message}${colors.reset}`);
        console.error(e);
        process.exit(1);
    });
}
