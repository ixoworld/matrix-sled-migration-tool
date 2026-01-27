#!/usr/bin/env npx ts-node
/**
 * enable-backup.ts
 *
 * Creates a new server-side key backup and generates the recovery key.
 * The recovery key MUST be saved securely - it's the only way to recover
 * the encryption keys if something goes wrong.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BackupDecryptionKey } from '@ixo/matrix-sdk-crypto-nodejs';
import { config, saveMigrationState, validateConfig } from '../config';
import {
    whoami,
    getBackupVersion,
    createBackupVersion,
} from '../utils/matrix-api';

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
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

function logWarning(message: string): void {
    console.log(`${colors.yellow}WARNING: ${message}${colors.reset}`);
}

function logImportant(message: string): void {
    console.log(`${colors.bold}${colors.cyan}${message}${colors.reset}`);
}

/**
 * Generate a Curve25519 key pair for backup encryption
 * Uses the matrix-sdk-crypto-nodejs library for proper key generation
 */
async function generateBackupKey(): Promise<{
    privateKey: Buffer;
    publicKey: string;
    recoveryKey: string;
}> {
    // Generate random 32 bytes for the private key seed
    const seed = crypto.randomBytes(32);
    const seedBase64 = seed.toString('base64');

    // Use the Rust SDK to create a proper BackupDecryptionKey
    // This derives the correct Curve25519 public key from the seed
    const decryptionKey = BackupDecryptionKey.fromBase64(seedBase64);
    const publicKey = decryptionKey.megolmV1PublicKey.publicKeyBase64;

    // Generate the recovery key in the standard Matrix format
    // Recovery keys are base58-encoded with prefix and parity byte
    const withoutParity = Buffer.concat([
        Buffer.from([0x8b, 0x01]), // Prefix for recovery key v1
        seed,
    ]);
    // Calculate parity byte (XOR of all bytes)
    let parity = 0;
    for (const byte of withoutParity) {
        parity ^= byte;
    }
    const recoveryKeyBytes = Buffer.concat([withoutParity, Buffer.from([parity])]);
    const recoveryKey = encodeBase58(recoveryKeyBytes);

    // Format the recovery key with spaces for readability
    const formattedRecoveryKey = recoveryKey.match(/.{1,4}/g)?.join(' ') || recoveryKey;

    return {
        privateKey: seed,
        publicKey: publicKey,
        recoveryKey: formattedRecoveryKey,
    };
}

/**
 * Base58 encoding (used for recovery keys)
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

export async function runEnableBackup(): Promise<void> {
    log('==============================================');
    log('Matrix Bot Server Backup Setup');
    log('==============================================');
    log('');

    // Validate configuration
    try {
        validateConfig();
    } catch (e) {
        logError((e as Error).message);
        process.exit(1);
    }

    const apiConfig = {
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

    // Check for existing backup
    log('');
    log('Checking for existing backup...');
    const existingBackup = await getBackupVersion(apiConfig);

    if (existingBackup) {
        logWarning(`An existing backup version (${existingBackup.version}) was found.`);
        log(`  Algorithm: ${existingBackup.algorithm}`);
        log(`  Key count: ${existingBackup.count}`);
        log('');

        // Check if we should continue (non-interactive mode skips prompt)
        if (!process.env.FORCE_NEW_BACKUP) {
            const readline = require('readline');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            const answer = await new Promise<string>((resolve) => {
                rl.question('Create a NEW backup version? This will NOT delete the existing backup. (y/N): ', resolve);
            });
            rl.close();

            if (answer.toLowerCase() !== 'y') {
                log('Backup setup cancelled. You can use the existing backup or delete it first.');
                process.exit(0);
            }
        } else {
            log('FORCE_NEW_BACKUP is set, proceeding with new backup creation...');
        }
    } else {
        log('  No existing backup found. Creating new backup...');
    }

    // Generate backup keys
    log('');
    log('Generating backup encryption keys...');

    const { privateKey, publicKey, recoveryKey } = await generateBackupKey();

    log('  Keys generated successfully');

    // Create the backup version on the server
    log('');
    log('Creating backup version on server...');

    let backupVersion: string;
    try {
        backupVersion = await createBackupVersion(apiConfig, publicKey);
        log(`  Backup version created: ${backupVersion}`);
    } catch (e) {
        logError(`Failed to create backup: ${(e as Error).message}`);
        process.exit(1);
    }

    // Save the recovery key
    const recoveryKeyPath = config.recoveryKeyPath;
    log('');
    log(`Saving recovery key to: ${recoveryKeyPath}`);

    try {
        // Ensure directory exists
        const dir = path.dirname(recoveryKeyPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Create a detailed recovery file
        const recoveryFileContent = `Matrix Key Backup Recovery Key
================================

User ID: ${userId}
Backup Version: ${backupVersion}
Created: ${new Date().toISOString()}

RECOVERY KEY:
${recoveryKey}

================================
IMPORTANT: Store this key securely!

This key is required to recover your encryption keys if:
- The bot's crypto store is lost or corrupted
- You need to restore keys on a new device
- The migration process fails

Recommended storage locations:
1. Password manager (e.g., 1Password, Bitwarden)
2. Encrypted file on a backup drive
3. Physical safe (printed copy)

DO NOT:
- Commit this file to version control
- Share it with anyone
- Store it unencrypted on a server
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

    // Save the private key for use in key encryption
    const privateKeyPath = path.join(path.dirname(recoveryKeyPath), 'backup-private-key.bin');
    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
    log(`  Private key saved to: ${privateKeyPath}`);

    // Save the public key for reference
    const publicKeyPath = path.join(path.dirname(recoveryKeyPath), 'backup-public-key.txt');
    fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });
    log(`  Public key saved to: ${publicKeyPath}`);

    // Update migration state
    saveMigrationState({ backupVersion });

    // Summary
    log('');
    log('==============================================');
    logSuccess('Backup Setup Complete!');
    log('==============================================');
    log('');
    log(`Backup Version: ${backupVersion}`);
    log(`Recovery Key File: ${recoveryKeyPath}`);
    log('');
    logImportant('IMPORTANT: Save your recovery key in multiple secure locations!');
    log('');
    log('Recovery Key:');
    logImportant(recoveryKey);
    log('');
    log('Next step: Run `sled-migration-tool upload` to upload extracted keys');
}

// Allow running directly
if (require.main === module) {
    runEnableBackup().catch((e) => {
        logError(`Unexpected error: ${e.message}`);
        console.error(e);
        process.exit(1);
    });
}
