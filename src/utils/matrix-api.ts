/**
 * Matrix API Utilities
 *
 * Helper functions for interacting with the Matrix Client-Server API
 * for backup and device management operations.
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface MatrixApiConfig {
    homeserverUrl: string;
    accessToken: string;
}

export interface BackupInfo {
    version: string;
    algorithm: string;
    auth_data: {
        public_key: string;
        signatures?: Record<string, Record<string, string>>;
    };
    count: number;
    etag: string;
}

export interface RoomKeyBackup {
    first_message_index: number;
    forwarded_count: number;
    is_verified: boolean;
    session_data: {
        ephemeral: string;
        ciphertext: string;
        mac: string;
    };
}

/**
 * Make an authenticated HTTP request to the Matrix homeserver
 */
export async function matrixRequest<T>(
    config: MatrixApiConfig,
    method: string,
    path: string,
    body?: unknown
): Promise<T> {
    const url = new URL(path, config.homeserverUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // Pre-stringify body to calculate Content-Length
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
            'Authorization': `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
            ...(bodyStr && { 'Content-Length': Buffer.byteLength(bodyStr) }),
        },
    };

    return new Promise((resolve, reject) => {
        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data) as T);
                    } catch (e) {
                        resolve(data as unknown as T);
                    }
                } else {
                    let errorBody: unknown;
                    try {
                        errorBody = JSON.parse(data);
                    } catch (e) {
                        errorBody = data;
                    }
                    reject(new Error(`Matrix API error ${res.statusCode}: ${JSON.stringify(errorBody)}`));
                }
            });
        });

        req.on('error', reject);

        if (bodyStr) {
            req.write(bodyStr);
        }
        req.end();
    });
}

/**
 * Get the current user's ID
 */
export async function whoami(config: MatrixApiConfig): Promise<string> {
    const response = await matrixRequest<{ user_id: string }>(
        config,
        'GET',
        '/_matrix/client/v3/account/whoami'
    );
    return response.user_id;
}

/**
 * Get current backup version info
 */
export async function getBackupVersion(config: MatrixApiConfig): Promise<BackupInfo | null> {
    try {
        return await matrixRequest<BackupInfo>(
            config,
            'GET',
            '/_matrix/client/v3/room_keys/version'
        );
    } catch (e) {
        const error = e as Error;
        if (error.message.includes('404')) {
            return null;
        }
        throw e;
    }
}

/**
 * Create a new backup version
 */
export async function createBackupVersion(
    config: MatrixApiConfig,
    publicKey: string
): Promise<string> {
    const response = await matrixRequest<{ version: string }>(
        config,
        'POST',
        '/_matrix/client/v3/room_keys/version',
        {
            algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
            auth_data: {
                public_key: publicKey,
            },
        }
    );
    return response.version;
}

/**
 * Upload room keys to the backup
 */
export async function uploadRoomKeys(
    config: MatrixApiConfig,
    version: string,
    roomId: string,
    sessionId: string,
    keyData: RoomKeyBackup
): Promise<void> {
    const encodedRoomId = encodeURIComponent(roomId);
    const encodedSessionId = encodeURIComponent(sessionId);

    await matrixRequest(
        config,
        'PUT',
        `/_matrix/client/v3/room_keys/keys/${encodedRoomId}/${encodedSessionId}?version=${version}`,
        keyData
    );
}

/**
 * Upload multiple room keys in batch
 */
export async function uploadRoomKeysBatch(
    config: MatrixApiConfig,
    version: string,
    rooms: Record<string, { sessions: Record<string, RoomKeyBackup> }>
): Promise<{ count: number; etag: string }> {
    return matrixRequest(
        config,
        'PUT',
        `/_matrix/client/v3/room_keys/keys?version=${version}`,
        { rooms }
    );
}

/**
 * Get the count of keys in the backup
 */
export async function getBackupKeyCount(config: MatrixApiConfig, version: string): Promise<number> {
    const info = await matrixRequest<{ count: number }>(
        config,
        'GET',
        `/_matrix/client/v3/room_keys/version/${version}`
    );
    return info.count;
}

/**
 * Get all backed up keys (for verification)
 */
export async function getBackupKeys(
    config: MatrixApiConfig,
    version: string
): Promise<{ rooms: Record<string, { sessions: Record<string, RoomKeyBackup> }> }> {
    return matrixRequest(
        config,
        'GET',
        `/_matrix/client/v3/room_keys/keys?version=${version}`
    );
}

/**
 * List user's devices
 */
export async function listDevices(config: MatrixApiConfig): Promise<{
    devices: Array<{
        device_id: string;
        display_name?: string;
        last_seen_ip?: string;
        last_seen_ts?: number;
    }>;
}> {
    return matrixRequest(
        config,
        'GET',
        '/_matrix/client/v3/devices'
    );
}

/**
 * Delete a device (requires user-interactive auth)
 * Note: This may require additional authentication flow
 */
export async function deleteDevice(
    config: MatrixApiConfig,
    deviceId: string,
    auth?: { type: string; password?: string; session?: string; user?: string; identifier?: { type: string; user: string } }
): Promise<void> {
    const body: { auth?: unknown } = {};
    if (auth) {
        body.auth = auth;
    }

    await matrixRequest(
        config,
        'DELETE',
        `/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`,
        Object.keys(body).length > 0 ? body : undefined
    );
}

/**
 * Get account data for a user
 */
export async function getAccountData(
    config: MatrixApiConfig,
    userId: string,
    type: string
): Promise<any | null> {
    try {
        return await matrixRequest<any>(
            config,
            'GET',
            `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`
        );
    } catch (e) {
        const error = e as Error;
        if (error.message.includes('404')) {
            return null;
        }
        throw e;
    }
}

/**
 * Start a user-interactive auth session for device deletion
 */
export async function startDeviceDeletionAuth(
    config: MatrixApiConfig,
    deviceId: string
): Promise<{
    session: string;
    flows: Array<{ stages: string[] }>;
}> {
    try {
        await matrixRequest(
            config,
            'DELETE',
            `/_matrix/client/v3/devices/${encodeURIComponent(deviceId)}`,
            {}
        );
        throw new Error('Expected 401 response for UIA');
    } catch (e) {
        const error = e as Error;
        if (error.message.includes('401')) {
            const match = error.message.match(/\{.*\}/);
            if (match) {
                return JSON.parse(match[0]);
            }
        }
        throw e;
    }
}
