#!/usr/bin/env npx ts-node
/**
 * generate-key.ts
 *
 * Generates a recovery key for Matrix key backup.
 * Use this to pre-generate a key before deploying a new bot.
 *
 * Output: JSON with recoveryKey (base58 with spaces) and recoveryKeyBase64
 */

import * as crypto from 'crypto';
import { BackupDecryptionKey } from '@ixo/matrix-sdk-crypto-nodejs';

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

export async function runGenerateKey(): Promise<void> {
    // Generate random 32 bytes for the private key seed
    const seed = crypto.randomBytes(32);
    const seedBase64 = seed.toString('base64');

    // Derive the public key using the Rust SDK
    const decryptionKey = BackupDecryptionKey.fromBase64(seedBase64);
    const publicKey = decryptionKey.megolmV1PublicKey.publicKeyBase64;

    // Generate recovery key in standard Matrix format (base58 with prefix and parity)
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
    const recoveryKeyRaw = encodeBase58(recoveryKeyBytes);

    // Format with spaces for readability
    const recoveryKey = recoveryKeyRaw.match(/.{1,4}/g)?.join(' ') || recoveryKeyRaw;

    // Output clean JSON
    console.log(JSON.stringify({
        recoveryKey,              // Base58 with spaces (human-readable)
        recoveryKeyBase64: seedBase64,  // Base64 (for config)
        publicKey,                // For reference
    }, null, 2));
}

// Allow running directly
if (require.main === module) {
    runGenerateKey().catch((e) => {
        console.error(JSON.stringify({ error: (e as Error).message }));
        process.exit(1);
    });
}
