#!/usr/bin/env npx ts-node
/**
 * delete-device.ts
 *
 * Deletes the old device from the Matrix server after verifying that
 * the backup is complete. This is the final step of the sled-migration
 * phase.
 *
 * WARNING: This operation cannot be undone. Make sure you have:
 * 1. Verified the backup is complete (sled-migration-tool verify)
 * 2. Saved the recovery key in multiple secure locations
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { config, validateConfig } from '../config';
import {
    listDevices,
    deleteDevice,
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
    console.log(`${colors.green}${message}${colors.reset}`);
}

function logWarning(message: string): void {
    console.log(`${colors.yellow}WARNING: ${message}${colors.reset}`);
}

function logImportant(message: string): void {
    console.log(`${colors.bold}${colors.red}${message}${colors.reset}`);
}

async function prompt(question: string, envVar?: string): Promise<string> {
    // Check for environment variable override (for non-interactive use)
    if (envVar) {
        const envValue = process.env[envVar];
        if (envValue) {
            console.log(question + envValue.replace(/./g, '*'));
            return envValue;
        }
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

export async function runDeleteDevice(): Promise<void> {
    log('==============================================');
    log('Matrix Bot Device Deletion');
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

    // Get user info
    log('Authenticating...');
    let userId: string;
    try {
        userId = await whoami(apiConfig);
        log(`  User: ${userId}`);
    } catch (e) {
        logError(`Authentication failed: ${(e as Error).message}`);
        process.exit(1);
    }

    // Check recovery key exists
    log('');
    log('Checking recovery key...');
    if (!fs.existsSync(config.recoveryKeyPath)) {
        logError('Recovery key file not found!');
        log('Please run the backup setup step first (sled-migration-tool enable)');
        process.exit(1);
    }
    logSuccess('  Recovery key file found');

    // Get old device ID
    let deviceIdToDelete = config.oldDeviceId;

    if (!deviceIdToDelete) {
        log('');
        logWarning('Old device ID not found in configuration.');
        log('');

        // List devices and let user choose
        try {
            const devices = await listDevices(apiConfig);
            log('Available devices:');
            devices.devices.forEach((d, i) => {
                log(`  ${i + 1}. ${d.device_id}${d.display_name ? ` (${d.display_name})` : ''}`);
                if (d.last_seen_ts) {
                    log(`     Last seen: ${new Date(d.last_seen_ts).toISOString()}`);
                }
            });

            log('');
            const choice = await prompt('Enter device number to delete (or "q" to quit): ');

            if (choice.toLowerCase() === 'q') {
                log('Cancelled.');
                process.exit(0);
            }

            const index = parseInt(choice, 10) - 1;
            if (isNaN(index) || index < 0 || index >= devices.devices.length) {
                logError('Invalid selection');
                process.exit(1);
            }

            deviceIdToDelete = devices.devices[index].device_id;
        } catch (e) {
            logError(`Could not list devices: ${(e as Error).message}`);
            process.exit(1);
        }
    }

    log('');
    log(`Device to delete: ${colors.bold}${deviceIdToDelete}${colors.reset}`);

    // Verify device exists
    try {
        const devices = await listDevices(apiConfig);
        const device = devices.devices.find(d => d.device_id === deviceIdToDelete);

        if (!device) {
            logError(`Device ${deviceIdToDelete} not found on server.`);
            log('It may have already been deleted.');
            process.exit(1);
        }

        log(`  Display name: ${device.display_name || 'None'}`);
        if (device.last_seen_ts) {
            log(`  Last seen: ${new Date(device.last_seen_ts).toISOString()}`);
        }
    } catch (e) {
        logWarning(`Could not verify device: ${(e as Error).message}`);
    }

    // Final warning
    log('');
    log('==============================================');
    logImportant('WARNING: THIS ACTION CANNOT BE UNDONE');
    log('==============================================');
    log('');
    log('Deleting this device will:');
    log('1. Remove all encryption keys stored locally on that device');
    log('2. Prevent the old bot from syncing with this account');
    log('3. Remove the device from your account\'s device list');
    log('');
    log('Make sure you have:');
    log('1. Saved the recovery key in multiple secure locations');
    log('2. Verified the backup is complete');
    log('3. Stopped the old bot');
    log('');

    // Auto-confirm if MIGRATION_CONFIRM env var matches device ID
    const confirm = process.env.MIGRATION_CONFIRM === deviceIdToDelete
        ? deviceIdToDelete
        : await prompt(`Type "${deviceIdToDelete}" to confirm deletion: `);

    if (confirm !== deviceIdToDelete) {
        log('');
        log('Confirmation failed. Device NOT deleted.');
        process.exit(1);
    }

    // Attempt deletion
    log('');
    log('Deleting device...');

    try {
        // First attempt - may require user-interactive auth
        await deleteDevice(apiConfig, deviceIdToDelete);
        logSuccess(`Device ${deviceIdToDelete} deleted successfully!`);
    } catch (e) {
        const error = e as Error;

        // Check if UIA is required
        if (error.message.includes('401')) {
            log('');
            log('User-interactive authentication required.');
            log('');

            // Extract UIA data directly from the first 401 error
            const uiaMatch = error.message.match(/\{.*\}/);
            if (!uiaMatch) {
                logError('Could not parse UIA response from server');
                process.exit(1);
            }

            let uiaData: { session: string; flows: Array<{ stages: string[] }> };
            try {
                uiaData = JSON.parse(uiaMatch[0]);
            } catch (parseError) {
                logError('Could not parse UIA JSON response');
                process.exit(1);
            }

            log(`Auth flows available: ${JSON.stringify(uiaData.flows)}`);
            log('');

            // Check for password auth
            const hasPasswordAuth = uiaData.flows.some(
                (f) => f.stages.includes('m.login.password')
            );

            if (hasPasswordAuth) {
                const password = await prompt('Enter account password: ', 'MIGRATION_PASSWORD');

                try {
                    await deleteDevice(apiConfig, deviceIdToDelete, {
                        type: 'm.login.password',
                        password: password,
                        session: uiaData.session,
                        identifier: {
                            type: 'm.id.user',
                            user: userId,
                        },
                    });
                    logSuccess(`Device ${deviceIdToDelete} deleted successfully!`);
                } catch (e2) {
                    logError(`Deletion with password failed: ${(e2 as Error).message}`);
                    log('');
                    log('You may need to delete the device manually:');
                    log(`1. Go to ${config.homeserverUrl}/_matrix/client/#/settings/devices`);
                    log(`2. Find device: ${deviceIdToDelete}`);
                    log('3. Click "Remove" and confirm with your password');
                    process.exit(1);
                }
            } else {
                logWarning('Password authentication not available.');
                log(`Available auth flows: ${JSON.stringify(uiaData.flows)}`);
                log('');
                log('You may need to delete the device manually through the Matrix client.');
                process.exit(1);
            }
        } else {
            logError(`Deletion failed: ${error.message}`);
            process.exit(1);
        }
    }

    // Verify deletion
    log('');
    log('Verifying deletion...');
    try {
        const devices = await listDevices(apiConfig);
        const stillExists = devices.devices.find(d => d.device_id === deviceIdToDelete);

        if (stillExists) {
            logWarning('Device still appears in device list. It may take a moment to propagate.');
        } else {
            logSuccess('Device successfully removed from account');
        }

        log('');
        log('Remaining devices:');
        devices.devices.forEach(d => {
            log(`  - ${d.device_id}${d.display_name ? ` (${d.display_name})` : ''}`);
        });
    } catch (e) {
        logWarning(`Could not verify deletion: ${(e as Error).message}`);
    }

    // Summary
    log('');
    log('==============================================');
    logSuccess('sled-migration Phase Complete!');
    log('==============================================');
    log('');
    log('The old device has been deleted. Your encryption keys are');
    log('now stored in the server backup.');
    log('');
    log('Next steps:');
    log('1. Deploy the updated bot with SQLite crypto store support');
    log('2. Recover keys using the recovery key');
    log('3. Start the bot');
    log('');
    logImportant('Remember: Keep your recovery key safe!');
}

// Allow running directly
if (require.main === module) {
    runDeleteDevice().catch((e) => {
        logError(`Unexpected error: ${e.message}`);
        console.error(e);
        process.exit(1);
    });
}
