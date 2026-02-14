#!/usr/bin/env node
/**
 * Sled Migration Tool CLI
 *
 * Standalone tool to migrate Matrix bot Sled crypto stores to SQLite
 * via server-side key backup.
 *
 * Usage:
 *   HOMESERVER_URL=https://matrix.example.com \
 *   ACCESS_TOKEN=syt_xxx \
 *   STORAGE_PATH=/app/storage \
 *   npx @ixo/matrix-sled-migration <command>
 *
 * Commands:
 *   backup    - Create backup of crypto store (shell script)
 *   extract   - Extract keys from Sled (requires Rust)
 *   enable    - Enable server backup, generate recovery key
 *   upload    - Upload extracted keys to backup
 *   verify    - Verify backup completeness
 *   delete    - Delete old device (requires password)
 *   all       - Run full migration (enable through verify)
 */

import { spawn } from 'child_process';
import * as path from 'path';

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

function logHeader(message: string): void {
    console.log(`${colors.bold}${colors.cyan}${message}${colors.reset}`);
}

function showHelp(): void {
    log('');
    logHeader('Sled Migration Tool');
    log('');
    log('Migrate Matrix bot Sled crypto stores to SQLite via server backup.');
    log('');
    log('Usage:');
    log('  npx @ixo/matrix-sled-migration <command>');
    log('');
    log('Environment Variables (required):');
    log('  HOMESERVER_URL    Matrix homeserver URL (e.g., https://matrix.example.com)');
    log('  ACCESS_TOKEN      Bot\'s access token');
    log('  STORAGE_PATH      Path to bot\'s storage directory');
    log('');
    log('Environment Variables (optional):');
    log('  CRYPTO_STORE_PATH Path to crypto store (default: STORAGE_PATH/encrypted)');
    log('  MIGRATION_DIR     Directory for migration files (default: current directory)');
    log('  OLD_DEVICE_ID     Device ID to delete (auto-detected from bot-sdk.json)');
    log('  MIGRATION_PASSWORD Account password for device deletion');
    log('  MIGRATION_CONFIRM  Device ID to confirm deletion (for non-interactive use)');
    log('  RECOVERY_PHRASE   Oracle recovery phrase for SSSS extraction (oracle-all, extract-backup-key)');
    log('');
    log('Commands:');
    log('  backup            Create backup of current crypto store');
    log('  extract           Extract keys from Sled store (requires Rust toolchain)');
    log('  enable            Enable server backup and generate recovery key');
    log('  upload            Upload extracted keys to server backup');
    log('  verify            Verify backup completeness');
    log('  delete            Delete old device (requires password)');
    log('  all               Run full migration (enable -> upload -> verify)');
    log('  generate-key      Generate a new recovery key (for new deployments)');
    log('  extract-backup-key Extract backup key from SSSS (for oracles with existing backup)');
    log('  oracle-all        Run oracle migration (extract-backup-key -> upload -> verify)');
    log('');
    log('Example:');
    log('  HOMESERVER_URL=https://matrix.ixo.world \\');
    log('  ACCESS_TOKEN=syt_xxx \\');
    log('  STORAGE_PATH=/app/storage \\');
    log('  npx @ixo/matrix-sled-migration all');
    log('');
}

async function runCommand(command: string): Promise<void> {
    const scriptDir = path.resolve(__dirname, '..');
    const scriptsDir = path.join(scriptDir, 'scripts');
    const commandsDir = __dirname.includes('/lib/')
        ? path.join(scriptDir, 'lib', 'commands')
        : path.join(scriptDir, 'src', 'commands');

    switch (command) {
        case 'backup': {
            const script = path.join(scriptsDir, '01-backup-store.sh');
            const child = spawn('bash', [script], {
                stdio: 'inherit',
                env: { ...process.env },
            });
            await new Promise<void>((resolve, reject) => {
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`Backup script exited with code ${code}`));
                });
            });
            break;
        }

        case 'extract': {
            const script = path.join(scriptsDir, '02-extract-keys.sh');
            const child = spawn('bash', [script], {
                stdio: 'inherit',
                env: { ...process.env },
            });
            await new Promise<void>((resolve, reject) => {
                child.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`Extract script exited with code ${code}`));
                });
            });
            break;
        }

        case 'enable': {
            const { runEnableBackup } = await import('./commands/enable-backup');
            await runEnableBackup();
            break;
        }

        case 'upload': {
            const { runUploadKeys } = await import('./commands/upload-keys');
            await runUploadKeys();
            break;
        }

        case 'verify': {
            const { runVerifyBackup } = await import('./commands/verify-backup');
            await runVerifyBackup();
            break;
        }

        case 'delete': {
            const { runDeleteDevice } = await import('./commands/delete-device');
            await runDeleteDevice();
            break;
        }

        case 'generate-key':
        case 'generate': {
            const { runGenerateKey } = await import('./commands/generate-key');
            await runGenerateKey();
            break;
        }

        case 'extract-backup-key': {
            const { runExtractBackupKey } = await import('./commands/extract-backup-key');
            await runExtractBackupKey();
            break;
        }

        case 'oracle-all': {
            log('');
            logHeader('Running Oracle Migration (extract-backup-key -> upload -> verify)');
            log('');

            log('Step 1/3: Extracting backup key from SSSS...');
            const { runExtractBackupKey: extractKey } = await import('./commands/extract-backup-key');
            await extractKey();

            log('');
            log('Step 2/3: Uploading keys to backup...');
            const { runUploadKeys: uploadKeys } = await import('./commands/upload-keys');
            await uploadKeys();

            log('');
            log('Step 3/3: Verifying backup...');
            const { runVerifyBackup: verifyBackup } = await import('./commands/verify-backup');
            await verifyBackup();

            log('');
            logSuccess('==============================================');
            logSuccess('Oracle Migration Complete!');
            logSuccess('==============================================');
            log('');
            log('The backup key has been extracted from SSSS and keys uploaded.');
            log('');
            log('Next steps:');
            log('  1. Clear old storage (rm -rf /bot/storage/*)');
            log('  2. Deploy updated oracle image with sqlite support');
            log('  3. The oracle will auto-extract the backup key from SSSS on startup');
            break;
        }

        case 'all': {
            log('');
            logHeader('Running Full Migration (enable -> upload -> verify)');
            log('');

            log('Step 1/3: Enabling server backup...');
            const { runEnableBackup } = await import('./commands/enable-backup');
            await runEnableBackup();

            log('');
            log('Step 2/3: Uploading keys to backup...');
            const { runUploadKeys } = await import('./commands/upload-keys');
            await runUploadKeys();

            log('');
            log('Step 3/3: Verifying backup...');
            const { runVerifyBackup } = await import('./commands/verify-backup');
            await runVerifyBackup();

            log('');
            logSuccess('==============================================');
            logSuccess('Migration Complete!');
            logSuccess('==============================================');
            log('');
            log('IMPORTANT: Save your recovery key before proceeding!');
            log('');
            log('Next step: Run `npx @ixo/matrix-sled-migration delete` to delete the old device');
            log('(Only after confirming the recovery key is saved securely)');
            break;
        }

        default:
            logError(`Unknown command: ${command}`);
            showHelp();
            process.exit(1);
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        showHelp();
        process.exit(0);
    }

    const command = args[0].toLowerCase();

    try {
        await runCommand(command);
    } catch (e) {
        logError((e as Error).message);
        process.exit(1);
    }
}

main();
