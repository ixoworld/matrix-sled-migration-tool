#!/usr/bin/env npx ts-node
/**
 * upload-keys.ts
 *
 * Reads the extracted keys from JSON and uploads them to the Matrix
 * server backup using the OlmMachine for proper encryption.
 *
 * This approach:
 * 1. Imports extracted keys into the OlmMachine using importRoomKeys()
 * 2. Lets the OlmMachine's backupRoomKeys() handle proper Curve25519 encryption
 * 3. Uploads the properly encrypted batches to the server
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    OlmMachine,
    UserId,
    DeviceId,
    RequestType,
    StoreType,
} from '@ixo/matrix-sdk-crypto-nodejs';
import { config, validateConfig, saveMigrationState } from '../config';
import {
    matrixRequest,
    getBackupVersion,
    getBackupKeyCount,
    whoami,
    MatrixApiConfig,
} from '../utils/matrix-api';

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

function logWarning(message: string): void {
    console.log(`${colors.yellow}WARNING: ${message}${colors.reset}`);
}

function logProgress(current: number, total: number, message: string): void {
    const percentage = Math.round((current / total) * 100);
    const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    process.stdout.write(`\r  [${progressBar}] ${percentage}% - ${message}        `);
}

// Extracted key format from the Rust tool
interface ExtractedKey {
    room_id: string;
    session_id: string;
    algorithm: string;
    session_key: string;
    sender_key: string;
    sender_claimed_keys: Record<string, string>;
    forwarding_curve25519_key_chain: string[];
}

interface ExtractionOutput {
    version: number;
    total_keys: number;
    keys_by_room: Record<string, ExtractedKey[]>;
    all_keys: ExtractedKey[];
}

// Format expected by OlmMachine.importRoomKeys
interface ExportedRoomKey {
    algorithm: string;
    room_id: string;
    sender_key: string;
    session_id: string;
    session_key: string;
    sender_claimed_keys: Record<string, string>;
    forwarding_curve25519_key_chain: string[];
}

export async function runUploadKeys(): Promise<void> {
    log('==============================================');
    log('Matrix Bot Key Upload (via OlmMachine)');
    log('==============================================');
    log('');

    // Validate configuration
    try {
        validateConfig();
    } catch (e) {
        logError((e as Error).message);
        process.exit(1);
    }

    const apiConfig: MatrixApiConfig = {
        homeserverUrl: config.homeserverUrl,
        accessToken: config.accessToken,
    };

    // Check that extracted keys exist
    if (!fs.existsSync(config.extractedKeysPath)) {
        logError(`Extracted keys file not found: ${config.extractedKeysPath}`);
        log('Please run the key extraction step first (sled-migration-tool extract)');
        process.exit(1);
    }

    // Get user ID from server
    log('Getting user info...');
    let userId: string;
    try {
        userId = await whoami(apiConfig);
        log(`  User ID: ${userId}`);
        saveMigrationState({ userId });
    } catch (e) {
        logError(`Failed to get user ID: ${(e as Error).message}`);
        process.exit(1);
    }

    // Check that backup is configured
    log('');
    log('Checking backup configuration...');
    const backupInfo = await getBackupVersion(apiConfig);

    if (!backupInfo) {
        logError('No backup version found on server.');
        log('Please run the backup setup step first (sled-migration-tool enable)');
        process.exit(1);
    }

    log(`  Backup version: ${backupInfo.version}`);
    log(`  Algorithm: ${backupInfo.algorithm}`);
    log(`  Existing keys: ${backupInfo.count}`);

    const publicKey = backupInfo.auth_data.public_key;
    log(`  Public key: ${publicKey.substring(0, 20)}...`);

    // Load extracted keys
    log('');
    log('Loading extracted keys...');

    let extractedData: ExtractionOutput;
    try {
        extractedData = JSON.parse(fs.readFileSync(config.extractedKeysPath, 'utf-8'));
    } catch (e) {
        logError(`Failed to read extracted keys: ${(e as Error).message}`);
        process.exit(1);
    }

    log(`  Format version: ${extractedData.version}`);
    log(`  Total keys: ${extractedData.total_keys}`);
    log(`  Rooms: ${Object.keys(extractedData.keys_by_room).length}`);

    if (extractedData.total_keys === 0) {
        logWarning('No keys to upload!');
        process.exit(0);
    }

    // Convert extracted keys to the format expected by importRoomKeys
    log('');
    log('Preparing keys for import...');

    const keysForImport: ExportedRoomKey[] = extractedData.all_keys.map(key => ({
        algorithm: key.algorithm || 'm.megolm.v1.aes-sha2',
        room_id: key.room_id,
        sender_key: key.sender_key,
        session_id: key.session_id,
        session_key: key.session_key,
        sender_claimed_keys: key.sender_claimed_keys || {},
        forwarding_curve25519_key_chain: key.forwarding_curve25519_key_chain || [],
    }));

    log(`  Prepared ${keysForImport.length} keys for import`);

    // Create a fresh temporary directory for the OlmMachine store
    // Use timestamp to ensure uniqueness and avoid conflicts with previous runs
    const tempStorePath = path.join(config.migrationDir, `temp-crypto-store-${Date.now()}`);

    // Clean up any old temp stores
    const migrationDir = config.migrationDir;
    const oldTempStores = fs.readdirSync(migrationDir)
        .filter(f => f.startsWith('temp-crypto-store'))
        .map(f => path.join(migrationDir, f));
    for (const oldStore of oldTempStores) {
        try {
            fs.rmSync(oldStore, { recursive: true, force: true });
            log(`  Cleaned up old temp store: ${path.basename(oldStore)}`);
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    fs.mkdirSync(tempStorePath, { recursive: true });

    // Generate a temporary device ID for this migration
    const tempDeviceId = `MIGRATION_${Date.now()}`;

    log('');
    log('Initializing crypto engine...');

    // Create an OlmMachine instance
    let machine: OlmMachine;
    try {
        machine = await OlmMachine.initialize(
            new UserId(userId),
            new DeviceId(tempDeviceId),
            tempStorePath,
            '', // passphrase
            StoreType.Sqlite,
        );
        log(`  Device ID: ${tempDeviceId}`);
    } catch (e) {
        logError(`Failed to initialize OlmMachine: ${(e as Error).message}`);
        process.exit(1);
    }

    // Import the keys into the OlmMachine
    log('');
    log('Importing keys into crypto engine...');

    try {
        const importResult = await machine.importRoomKeys(
            JSON.stringify(keysForImport),
            null, // fromBackupVersion = null (these are keys we want to import fresh, not from backup)
        );
        log(`  Imported: ${importResult.importedCount} / ${importResult.totalCount} keys`);

        if (Number(importResult.importedCount) === 0) {
            logWarning('No keys were imported. They may already exist.');
        }
    } catch (e) {
        logError(`Failed to import keys: ${(e as Error).message}`);
        process.exit(1);
    }

    // Enable backup on the machine with the server's public key
    log('');
    log('Enabling backup encryption...');

    try {
        await machine.enableBackupV1(publicKey, backupInfo.version);
        log(`  Backup enabled for version ${backupInfo.version}`);
    } catch (e) {
        logError(`Failed to enable backup: ${(e as Error).message}`);
        process.exit(1);
    }

    // Let the machine backup the keys (properly encrypted)
    log('');
    log('Uploading encrypted keys to server...');

    let totalBatches = 0;
    let totalKeysUploaded = 0;

    try {
        while (true) {
            // Get a batch of properly encrypted keys from the machine
            const request = await machine.backupRoomKeys();

            if (!request) {
                // No more keys to backup
                break;
            }

            totalBatches++;
            const requestBody = JSON.parse(request.body);

            // Count keys in this batch
            let batchKeyCount = 0;
            if (requestBody.rooms) {
                for (const roomId of Object.keys(requestBody.rooms)) {
                    const sessions = requestBody.rooms[roomId]?.sessions;
                    if (sessions) {
                        batchKeyCount += Object.keys(sessions).length;
                    }
                }
            }

            logProgress(totalKeysUploaded + batchKeyCount, keysForImport.length,
                `Batch ${totalBatches}: uploading ${batchKeyCount} keys`);

            // Upload the properly encrypted keys to the server
            const uploadResponse = await matrixRequest<{ count: number; etag: string }>(
                apiConfig,
                'PUT',
                `/_matrix/client/v3/room_keys/keys?version=${backupInfo.version}`,
                requestBody,
            );

            // Mark the request as sent so the machine knows not to send it again
            // The Rust SDK expects the server's response JSON
            await machine.markRequestAsSent(request.id, RequestType.KeysBackup, JSON.stringify(uploadResponse));

            totalKeysUploaded += batchKeyCount;

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } catch (e) {
        logError(`\nFailed to upload keys: ${(e as Error).message}`);
        log('Some keys may have been uploaded. Check the server backup count.');
    }

    log(''); // New line after progress bar

    // Get final room key counts from the machine
    log('');
    log('Checking crypto engine status...');

    try {
        const counts = await machine.roomKeyCounts();
        log(`  Total keys in engine: ${counts.total}`);
        log(`  Keys backed up: ${counts.backedUp}`);
    } catch (e) {
        logWarning(`Could not get room key counts: ${(e as Error).message}`);
    }

    // Verify upload on server
    log('');
    log('Verifying upload on server...');

    try {
        const finalCount = await getBackupKeyCount(apiConfig, backupInfo.version);
        log(`  Keys in server backup: ${finalCount}`);

        const expectedTotal = backupInfo.count + keysForImport.length;
        if (finalCount >= expectedTotal) {
            logSuccess(`  All keys uploaded successfully!`);
        } else if (finalCount > backupInfo.count) {
            logSuccess(`  Uploaded ${finalCount - backupInfo.count} new keys`);
        } else {
            logWarning(`  Server count unchanged. Keys may have already existed.`);
        }
    } catch (e) {
        logWarning(`Could not verify upload: ${(e as Error).message}`);
    }

    // Clean up temp store (optional - keeping it allows resuming)
    // fs.rmSync(tempStorePath, { recursive: true, force: true });

    // Summary
    log('');
    log('==============================================');
    logSuccess('Key Upload Complete!');
    log('==============================================');
    log('');
    log(`Backup Version: ${backupInfo.version}`);
    log(`Batches Uploaded: ${totalBatches}`);
    log(`Keys Processed: ${totalKeysUploaded}`);
    log('');
    log('Next step: Run `sled-migration-tool verify` to verify the backup');
    log('Then start your bot - it should be able to recover keys from backup.');
}

// Allow running directly
if (require.main === module) {
    runUploadKeys().catch((e) => {
        logError(`Unexpected error: ${e.message}`);
        console.error(e);
        process.exit(1);
    });
}
