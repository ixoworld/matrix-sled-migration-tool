/**
 * Migration Configuration
 *
 * Loads configuration from environment variables for standalone operation.
 * This tool can be used against any Matrix bot's Sled crypto store.
 */

import * as path from 'path';
import * as fs from 'fs';

export interface MigrationConfig {
    // Matrix server configuration
    homeserverUrl: string;
    accessToken: string;
    userId: string;

    // Storage paths
    storagePath: string;
    cryptoStorePath: string;
    extractedKeysPath: string;
    recoveryKeyPath: string;
    migrationDir: string;

    // Device information
    oldDeviceId: string | null;
    newDeviceId: string | null;

    // Backup configuration
    backupVersion: string | null;
}

/**
 * Get required environment variable or throw
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Required environment variable ${name} is not set`);
    }
    return value;
}

/**
 * Get optional environment variable
 */
function optionalEnv(name: string, defaultValue: string = ''): string {
    return process.env[name] || defaultValue;
}

/**
 * Load configuration from environment variables
 */
function loadConfig(): MigrationConfig {
    // Core required configuration
    const homeserverUrl = requireEnv('HOMESERVER_URL');
    const accessToken = requireEnv('ACCESS_TOKEN');
    const storagePath = requireEnv('STORAGE_PATH');

    // Determine crypto store path (usually storage/encrypted)
    const cryptoStorePath = optionalEnv('CRYPTO_STORE_PATH', path.join(storagePath, 'encrypted'));

    // Migration working directory (where we store extracted keys, recovery key, etc.)
    const migrationDir = optionalEnv('MIGRATION_DIR', process.cwd());

    // Try to read the old device ID from bot-sdk.json
    let oldDeviceId: string | null = optionalEnv('OLD_DEVICE_ID') || null;
    if (!oldDeviceId) {
        const botSdkPath = path.join(cryptoStorePath, 'bot-sdk.json');
        if (fs.existsSync(botSdkPath)) {
            try {
                const botSdkData = JSON.parse(fs.readFileSync(botSdkPath, 'utf-8'));
                oldDeviceId = botSdkData.deviceId || null;
            } catch (e) {
                console.warn('Warning: Could not read device ID from bot-sdk.json');
            }
        }
    }

    // Try to read migration state (backup version, new device ID, etc.)
    let backupVersion: string | null = optionalEnv('BACKUP_VERSION') || null;
    let newDeviceId: string | null = optionalEnv('NEW_DEVICE_ID') || null;
    const migrationStatePath = path.join(migrationDir, 'migration-state.json');
    if (fs.existsSync(migrationStatePath)) {
        try {
            const state = JSON.parse(fs.readFileSync(migrationStatePath, 'utf-8'));
            backupVersion = backupVersion || state.backupVersion || null;
            newDeviceId = newDeviceId || state.newDeviceId || null;
        } catch (e) {
            console.warn('Warning: Could not read migration state');
        }
    }

    return {
        // Matrix configuration
        homeserverUrl,
        accessToken,
        userId: '', // Will be fetched from the server

        // Paths
        storagePath,
        cryptoStorePath,
        extractedKeysPath: path.join(migrationDir, 'extracted-keys.json'),
        recoveryKeyPath: path.join(migrationDir, 'recovery-key.txt'),
        migrationDir,

        // Device info
        oldDeviceId,
        newDeviceId,

        // Backup info
        backupVersion,
    };
}

// Lazy load config to allow env vars to be set before access
let _config: MigrationConfig | null = null;

export function getConfig(): MigrationConfig {
    if (!_config) {
        _config = loadConfig();
    }
    return _config;
}

// For backwards compatibility
export const config = new Proxy({} as MigrationConfig, {
    get(_, prop) {
        return getConfig()[prop as keyof MigrationConfig];
    }
});

/**
 * Save migration state (backup version, device IDs, etc.)
 */
export function saveMigrationState(updates: Partial<MigrationConfig>): void {
    const cfg = getConfig();
    const statePath = path.join(cfg.migrationDir, 'migration-state.json');

    let state: Record<string, unknown> = {};
    if (fs.existsSync(statePath)) {
        try {
            state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        } catch (e) {
            // Start fresh
        }
    }

    // Merge updates
    if (updates.backupVersion !== undefined) {
        state.backupVersion = updates.backupVersion;
    }
    if (updates.newDeviceId !== undefined) {
        state.newDeviceId = updates.newDeviceId;
    }
    if (updates.userId !== undefined) {
        state.userId = updates.userId;
    }

    state.lastUpdated = new Date().toISOString();

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Validate that required configuration is present
 */
export function validateConfig(): void {
    const errors: string[] = [];

    try {
        const cfg = getConfig();

        if (!cfg.homeserverUrl) {
            errors.push('HOMESERVER_URL environment variable is not set');
        }
        if (!cfg.accessToken) {
            errors.push('ACCESS_TOKEN environment variable is not set');
        }
        if (!cfg.storagePath) {
            errors.push('STORAGE_PATH environment variable is not set');
        }
    } catch (e) {
        errors.push((e as Error).message);
    }

    if (errors.length > 0) {
        throw new Error('Configuration errors:\n' + errors.map(e => `  - ${e}`).join('\n'));
    }
}

export default config;
