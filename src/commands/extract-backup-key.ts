#!/usr/bin/env npx ts-node
/**
 * extract-backup-key.ts
 *
 * Extracts the key backup decryption key from Matrix SSSS (Secret Storage)
 * using the oracle's recovery phrase (MATRIX_RECOVERY_PHRASE).
 *
 * This is used for oracle migrations where the backup already exists
 * (created during initial cross-signing setup) and we need the backup
 * key to upload extracted sled keys and for the bot-sdk to restore them.
 *
 * Requires: RECOVERY_PHRASE environment variable
 */

import * as fs from 'fs';
import * as path from 'path';
import { BackupDecryptionKey } from '@ixo/matrix-sdk-crypto-nodejs';
import { config, saveMigrationState, validateConfig } from '../config';
import {
    whoami,
    getBackupVersion,
    MatrixApiConfig,
} from '../utils/matrix-api';
import { extractBackupKeyFromSSS } from '../utils/ssss';

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
 * Base58 encoding (same as enable-backup.ts)
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
 * Format: [0x8b, 0x01] + 32-byte key + parity byte, Base58 encoded
 */
function backupKeyToRecoveryKey(backupKeyBase64: string): string {
    const seed = Buffer.from(backupKeyBase64, 'base64');

    const withoutParity = Buffer.concat([
        Buffer.from([0x8b, 0x01]), // Recovery key v1 prefix
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

export async function runExtractBackupKey(): Promise<void> {
    log('==============================================');
    log('Extract Backup Key from SSSS (Oracle Migration)');
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
        log('Set it as: RECOVERY_PHRASE="your_recovery_phrase" npx @ixo/matrix-sled-migration extract-backup-key');
        process.exit(1);
    }

    const apiConfig: MatrixApiConfig = {
        homeserverUrl: config.homeserverUrl,
        accessToken: config.accessToken,
    };

    // Get user ID
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

    // Verify backup exists on server
    log('');
    log('Checking for existing backup on server...');
    const backupInfo = await getBackupVersion(apiConfig);

    if (!backupInfo) {
        logError('No backup found on server. This command requires an existing backup.');
        log('');
        log('For normal bots (without SSSS), use the "enable" command instead.');
        process.exit(1);
    }

    log(`  Backup version: ${backupInfo.version}`);
    log(`  Algorithm: ${backupInfo.algorithm}`);
    log(`  Key count: ${backupInfo.count}`);

    // Extract backup key from SSSS
    log('');
    log('Extracting backup key from SSSS...');
    log('  Deriving SSSS key from recovery phrase (PBKDF2, this may take a moment)...');

    let backupKeyBase64: string | null;
    try {
        backupKeyBase64 = await extractBackupKeyFromSSS(apiConfig, userId, recoveryPhrase);
    } catch (e) {
        logError(`Failed to extract backup key: ${(e as Error).message}`);
        process.exit(1);
    }

    if (!backupKeyBase64) {
        logError('No backup key found in SSSS.');
        log('');
        log('This could mean:');
        log('  - SSSS (Secret Storage) is not set up for this user');
        log('  - The key backup decryption key is not stored in SSSS');
        log('  - The oracle has not completed its initial setup yet');
        process.exit(1);
    }

    logSuccess('  Backup key extracted successfully!');

    // Verify the key matches the server backup
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
            log('');
            log('The SSSS-stored backup key does not match the current server backup.');
            log('This could indicate the backup was recreated after SSSS was set up.');
            process.exit(1);
        }
    } catch (e) {
        logError(`Failed to verify key: ${(e as Error).message}`);
        process.exit(1);
    }

    // Convert to recovery key format
    const recoveryKey = backupKeyToRecoveryKey(backupKeyBase64);
    const seed = Buffer.from(backupKeyBase64, 'base64');

    // Save recovery key file (same format as enable command)
    const recoveryKeyPath = config.recoveryKeyPath;
    log('');
    log(`Saving recovery key to: ${recoveryKeyPath}`);

    try {
        const dir = path.dirname(recoveryKeyPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const recoveryFileContent = `Matrix Key Backup Recovery Key (Extracted from SSSS)
================================

User ID: ${userId}
Backup Version: ${backupInfo.version}
Extracted: ${new Date().toISOString()}
Source: SSSS (Secret Storage)

RECOVERY KEY:
${recoveryKey}

BASE64 KEY:
${backupKeyBase64}

================================
IMPORTANT: Store this key securely!

This is the key backup decryption key extracted from the oracle's
Secret Storage (SSSS). It was derived from the MATRIX_RECOVERY_PHRASE.

Use this key in the oracle's configuration to enable automatic
key backup and recovery with the matrix-bot-sdk.
================================
`;

        fs.writeFileSync(recoveryKeyPath, recoveryFileContent, { mode: 0o600 });
        logSuccess('  Recovery key saved!');
    } catch (e) {
        logError(`Failed to save recovery key: ${(e as Error).message}`);
        logImportant('');
        logImportant('CRITICAL: Copy this recovery key NOW:');
        logImportant('');
        logImportant(recoveryKey);
        logImportant('');
        process.exit(1);
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
    logSuccess('Backup Key Extraction Complete!');
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
    log('Next step: Run `npx @ixo/matrix-sled-migration upload` to upload extracted keys');
}

// Allow running directly
if (require.main === module) {
    runExtractBackupKey().catch((e) => {
        logError(`Unexpected error: ${e.message}`);
        console.error(e);
        process.exit(1);
    });
}
