/**
 * SSSS (Secret Storage) Utilities
 *
 * Implements Matrix Secret Storage decryption to extract secrets
 * (such as the key backup decryption key) from server-side account data.
 *
 * Crypto operations follow the Matrix spec:
 * - PBKDF2-SHA512 for passphrase → SSSS key derivation
 * - HKDF-SHA256 for SSSS key → AES + HMAC key derivation
 * - AES-CTR for decryption, HMAC-SHA256 for verification
 *
 * Reference: matrix-js-sdk implementations:
 * - src/crypto-api/key-passphrase.ts (PBKDF2)
 * - src/utils/internal/deriveKeys.ts (HKDF)
 * - src/utils/decryptAESSecretStorageItem.ts (AES-CTR + HMAC)
 */

import * as crypto from 'crypto';
import { getAccountData, MatrixApiConfig } from './matrix-api';

// Interfaces matching Matrix spec account_data event formats

interface SSSSKeyPassphraseInfo {
    algorithm: string; // "m.pbkdf2"
    iterations: number;
    salt: string;
    bits?: number; // default 256
}

interface SSSSKeyInfo {
    name?: string;
    algorithm: string; // "m.secret_storage.v1.aes-hmac-sha2"
    iv?: string;
    mac?: string;
    passphrase?: SSSSKeyPassphraseInfo;
}

interface SSSSEncryptedData {
    iv: string;
    ciphertext: string;
    mac: string;
}

interface SSSSSecretData {
    encrypted: Record<string, SSSSEncryptedData>;
}

/**
 * Derive the SSSS master key from a passphrase using PBKDF2-SHA512.
 */
export async function deriveSSSSKeyFromPassphrase(
    passphrase: string,
    salt: string,
    iterations: number,
    bits: number = 256,
): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
    );

    const keyBits = await crypto.subtle.deriveBits(
        {
            name: 'PBKDF2',
            salt: new TextEncoder().encode(salt),
            iterations,
            hash: 'SHA-512',
        },
        key,
        bits,
    );

    return new Uint8Array(keyBits);
}

/**
 * Derive AES and HMAC keys from the SSSS master key using HKDF-SHA256.
 *
 * Salt: 8 zero bytes
 * Info: UTF-8 encoded secret name
 * Output: 512 bits (first 256 = AES key, next 256 = HMAC key)
 */
async function deriveKeys(
    masterKey: Uint8Array,
    secretName: string,
) {
    const zeroSalt = new Uint8Array(8);

    const hkdfKey = await crypto.subtle.importKey(
        'raw',
        masterKey,
        { name: 'HKDF' },
        false,
        ['deriveBits'],
    );

    const keyBits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            salt: zeroSalt,
            info: new TextEncoder().encode(secretName),
            hash: 'SHA-256',
        },
        hkdfKey,
        512,
    );

    const aesKeyData = keyBits.slice(0, 32);
    const hmacKeyData = keyBits.slice(32);

    const aesKey = await crypto.subtle.importKey(
        'raw',
        aesKeyData,
        { name: 'AES-CTR' },
        false,
        ['encrypt', 'decrypt'],
    );

    const hmacKey = await crypto.subtle.importKey(
        'raw',
        hmacKeyData,
        { name: 'HMAC', hash: { name: 'SHA-256' } },
        false,
        ['sign', 'verify'],
    );

    return [aesKey, hmacKey];
}

function decodeBase64(base64: string): Uint8Array {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function encodeBase64(data: Uint8Array): string {
    return Buffer.from(data).toString('base64');
}

/**
 * Encrypt a value using SSSS (for key verification).
 */
async function encryptAESSecretStorageItem(
    data: string,
    masterKey: Uint8Array,
    secretName: string,
    providedIv?: string,
): Promise<{ iv: string; ciphertext: string; mac: string }> {
    const [aesKey, hmacKey] = await deriveKeys(masterKey, secretName);

    let iv: Uint8Array;
    if (providedIv) {
        iv = decodeBase64(providedIv);
    } else {
        iv = crypto.getRandomValues(new Uint8Array(16));
        // Clear bit 63 for Android compatibility
        iv[8] &= 0x7f;
    }

    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-CTR', counter: iv, length: 64 },
            aesKey,
            new TextEncoder().encode(data),
        ),
    );

    const mac = new Uint8Array(
        await crypto.subtle.sign(
            { name: 'HMAC' },
            hmacKey,
            ciphertext,
        ),
    );

    return {
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(ciphertext),
        mac: encodeBase64(mac),
    };
}

/**
 * Decrypt an SSSS-encrypted secret.
 */
export async function decryptSSSSSecret(
    encryptedData: SSSSEncryptedData,
    masterKey: Uint8Array,
    secretName: string,
): Promise<string> {
    const [aesKey, hmacKey] = await deriveKeys(masterKey, secretName);

    const ciphertext = decodeBase64(encryptedData.ciphertext);
    const mac = decodeBase64(encryptedData.mac);
    const iv = decodeBase64(encryptedData.iv);

    // Verify HMAC
    const isValid = await crypto.subtle.verify(
        { name: 'HMAC' },
        hmacKey,
        mac,
        ciphertext,
    );

    if (!isValid) {
        throw new Error(`SSSS decryption failed for "${secretName}": bad MAC (wrong passphrase?)`);
    }

    // Decrypt
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: iv, length: 64 },
        aesKey,
        ciphertext,
    );

    return new TextDecoder().decode(new Uint8Array(plaintext));
}

/**
 * Verify that an SSSS key matches the stored key check MAC.
 * Encrypts 32 zero bytes with empty string name and compares MAC.
 */
export async function verifySSSSKey(
    masterKey: Uint8Array,
    keyInfo: SSSSKeyInfo,
): Promise<boolean> {
    if (!keyInfo.iv || !keyInfo.mac) {
        // No key check info available, skip verification
        return true;
    }

    const zeroString = '\0'.repeat(32);
    const check = await encryptAESSecretStorageItem(zeroString, masterKey, '', keyInfo.iv);

    // Compare MACs (trim trailing = for compatibility)
    const expected = keyInfo.mac.replace(/=+$/, '');
    const actual = check.mac.replace(/=+$/, '');
    return expected === actual;
}

/**
 * Extract the key backup decryption key from SSSS.
 *
 * This performs the full chain:
 * 1. Fetch SSSS default key ID from account_data
 * 2. Fetch SSSS key metadata (salt, iterations)
 * 3. Derive SSSS master key from passphrase (PBKDF2-SHA512)
 * 4. Verify key against stored MAC
 * 5. Fetch encrypted backup key from account_data
 * 6. Decrypt using SSSS
 *
 * @returns Base64-encoded backup decryption key, or null if not available
 */
export async function extractBackupKeyFromSSS(
    apiConfig: MatrixApiConfig,
    userId: string,
    recoveryPhrase: string,
): Promise<string | null> {
    // 1. Get default SSSS key ID
    const defaultKeyData = await getAccountData(apiConfig, userId, 'm.secret_storage.default_key');
    if (!defaultKeyData || !defaultKeyData.key) {
        return null; // SSSS not set up
    }
    const keyId: string = defaultKeyData.key;

    // 2. Get SSSS key metadata
    const keyInfo: SSSSKeyInfo | null = await getAccountData(
        apiConfig,
        userId,
        `m.secret_storage.key.${keyId}`,
    );
    if (!keyInfo) {
        throw new Error(`SSSS key metadata not found for key ID: ${keyId}`);
    }

    if (keyInfo.algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
        throw new Error(`Unsupported SSSS algorithm: ${keyInfo.algorithm}`);
    }

    if (!keyInfo.passphrase || keyInfo.passphrase.algorithm !== 'm.pbkdf2') {
        throw new Error('SSSS key is not passphrase-based (no PBKDF2 info). Cannot derive from recovery phrase.');
    }

    // 3. Derive SSSS master key from passphrase
    const masterKey = await deriveSSSSKeyFromPassphrase(
        recoveryPhrase,
        keyInfo.passphrase.salt,
        keyInfo.passphrase.iterations,
        keyInfo.passphrase.bits || 256,
    );

    // 4. Verify key
    const keyValid = await verifySSSSKey(masterKey, keyInfo);
    if (!keyValid) {
        throw new Error('SSSS key verification failed: recovery phrase does not match');
    }

    // 5. Fetch encrypted backup key
    const backupSecret: SSSSSecretData | null = await getAccountData(
        apiConfig,
        userId,
        'm.megolm_backup.v1',
    );
    if (!backupSecret || !backupSecret.encrypted || !backupSecret.encrypted[keyId]) {
        return null; // No backup key stored in SSSS
    }

    // 6. Decrypt
    const backupKeyBase64 = await decryptSSSSSecret(
        backupSecret.encrypted[keyId],
        masterKey,
        'm.megolm_backup.v1',
    );

    return backupKeyBase64;
}
