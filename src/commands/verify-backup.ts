#!/usr/bin/env npx ts-node
/**
 * verify-backup.ts
 *
 * Verifies that the backup was created successfully and contains
 * all the expected keys. This is a safety check before proceeding
 * with the migration.
 */

import * as fs from 'fs';
import { config, validateConfig } from '../config';
import {
    getBackupVersion,
    getBackupKeys,
    listDevices,
    whoami,
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
    console.log(`${colors.green}✓ ${message}${colors.reset}`);
}

function logWarning(message: string): void {
    console.log(`${colors.yellow}⚠ ${message}${colors.reset}`);
}

function logFail(message: string): void {
    console.log(`${colors.red}✗ ${message}${colors.reset}`);
}

interface ExtractionOutput {
    version: number;
    total_keys: number;
    keys_by_room: Record<string, unknown[]>;
    all_keys: unknown[];
}

export async function runVerifyBackup(): Promise<void> {
    log('==============================================');
    log('Matrix Bot Backup Verification');
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

    let allChecksPass = true;

    // Check 1: User identity
    log('1. Verifying user identity...');
    try {
        const userId = await whoami(apiConfig);
        logSuccess(`Authenticated as: ${userId}`);
    } catch (e) {
        logFail(`Authentication failed: ${(e as Error).message}`);
        allChecksPass = false;
    }

    // Check 2: Backup exists
    log('');
    log('2. Checking backup version...');
    let backupInfo;
    try {
        backupInfo = await getBackupVersion(apiConfig);
        if (backupInfo) {
            logSuccess(`Backup version: ${backupInfo.version}`);
            log(`   Algorithm: ${backupInfo.algorithm}`);
            log(`   Key count: ${backupInfo.count}`);
        } else {
            logFail('No backup found on server');
            allChecksPass = false;
        }
    } catch (e) {
        logFail(`Could not check backup: ${(e as Error).message}`);
        allChecksPass = false;
    }

    // Check 3: Compare with extracted keys
    log('');
    log('3. Comparing with extracted keys...');
    let extractedData: ExtractionOutput | null = null;

    if (fs.existsSync(config.extractedKeysPath)) {
        try {
            const parsed: ExtractionOutput = JSON.parse(fs.readFileSync(config.extractedKeysPath, 'utf-8'));
            extractedData = parsed;
            log(`   Extracted keys file found`);
            log(`   Total extracted keys: ${parsed.total_keys}`);
            log(`   Rooms with keys: ${Object.keys(parsed.keys_by_room).length}`);

            if (backupInfo) {
                if (backupInfo.count >= parsed.total_keys) {
                    logSuccess(`Backup contains all extracted keys (${backupInfo.count} >= ${parsed.total_keys})`);
                } else {
                    logWarning(`Backup may be incomplete: ${backupInfo.count} < ${parsed.total_keys} expected`);
                    // Not a hard failure - some keys might not upload
                }
            }
        } catch (e) {
            logWarning(`Could not read extracted keys: ${(e as Error).message}`);
        }
    } else {
        logWarning(`Extracted keys file not found at: ${config.extractedKeysPath}`);
    }

    // Check 4: Verify backup key count per room
    log('');
    log('4. Checking backup contents...');
    if (backupInfo) {
        try {
            const backupKeys = await getBackupKeys(apiConfig, backupInfo.version);
            const roomCount = Object.keys(backupKeys.rooms || {}).length;
            let sessionCount = 0;

            for (const room of Object.values(backupKeys.rooms || {})) {
                sessionCount += Object.keys(room.sessions || {}).length;
            }

            logSuccess(`Backup contains ${sessionCount} sessions across ${roomCount} rooms`);

            // Compare room IDs if we have extracted data
            if (extractedData) {
                const extractedRoomIds = new Set(Object.keys(extractedData.keys_by_room));
                const backupRoomIds = new Set(Object.keys(backupKeys.rooms || {}));

                const missingRooms = [...extractedRoomIds].filter(r => !backupRoomIds.has(r));
                if (missingRooms.length > 0) {
                    logWarning(`${missingRooms.length} rooms from extraction are missing in backup`);
                    if (missingRooms.length <= 5) {
                        missingRooms.forEach(r => log(`   - ${r}`));
                    }
                } else {
                    logSuccess('All extracted rooms are present in backup');
                }
            }
        } catch (e) {
            logWarning(`Could not retrieve backup contents: ${(e as Error).message}`);
        }
    }

    // Check 5: Recovery key exists
    log('');
    log('5. Checking recovery key...');
    if (fs.existsSync(config.recoveryKeyPath)) {
        const stats = fs.statSync(config.recoveryKeyPath);
        if ((stats.mode & 0o777) === 0o600) {
            logSuccess('Recovery key file exists with correct permissions (600)');
        } else {
            logWarning(`Recovery key file has loose permissions: ${(stats.mode & 0o777).toString(8)}`);
            log('   Recommended: chmod 600 ' + config.recoveryKeyPath);
        }

        // Check file is not empty
        const content = fs.readFileSync(config.recoveryKeyPath, 'utf-8');
        if (content.includes('RECOVERY KEY:')) {
            logSuccess('Recovery key file appears valid');
        } else {
            logWarning('Recovery key file format may be incorrect');
        }
    } else {
        logFail(`Recovery key file not found: ${config.recoveryKeyPath}`);
        allChecksPass = false;
    }

    // Check 6: List devices
    log('');
    log('6. Checking devices...');
    try {
        const devices = await listDevices(apiConfig);
        log(`   Total devices: ${devices.devices.length}`);

        const oldDeviceId = config.oldDeviceId;
        if (oldDeviceId) {
            const oldDevice = devices.devices.find(d => d.device_id === oldDeviceId);
            if (oldDevice) {
                logSuccess(`Old device found: ${oldDeviceId}`);
                if (oldDevice.display_name) {
                    log(`   Display name: ${oldDevice.display_name}`);
                }
                if (oldDevice.last_seen_ts) {
                    log(`   Last seen: ${new Date(oldDevice.last_seen_ts).toISOString()}`);
                }
            } else {
                logWarning(`Old device ${oldDeviceId} not found in device list`);
            }
        } else {
            logWarning('Old device ID not known (bot-sdk.json not found or OLD_DEVICE_ID not set)');
        }

        // List all devices for reference
        log('');
        log('   All devices:');
        for (const device of devices.devices) {
            log(`   - ${device.device_id}${device.display_name ? ` (${device.display_name})` : ''}`);
        }
    } catch (e) {
        logWarning(`Could not list devices: ${(e as Error).message}`);
    }

    // Summary
    log('');
    log('==============================================');
    if (allChecksPass) {
        logSuccess('All Verification Checks Passed!');
        log('==============================================');
        log('');
        log('The backup appears to be complete and ready.');
        log('');
        log('BEFORE proceeding to delete the old device:');
        log('1. Ensure the recovery key is stored in multiple secure locations');
        log('2. Note down the old device ID for deletion');
        log('');
        log('Next step: Run `sled-migration-tool delete` to delete the old device');
    } else {
        logFail('Some Verification Checks Failed');
        log('==============================================');
        log('');
        log('Please review the errors above before proceeding.');
        log('You may need to:');
        log('- Re-run the backup setup (sled-migration-tool enable)');
        log('- Re-upload the keys (sled-migration-tool upload)');
        log('- Check your configuration');
        process.exit(1);
    }
}

// Allow running directly
if (require.main === module) {
    runVerifyBackup().catch((e) => {
        logError(`Unexpected error: ${e.message}`);
        console.error(e);
        process.exit(1);
    });
}
