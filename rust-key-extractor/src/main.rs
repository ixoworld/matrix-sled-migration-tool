//! Sled Key Extractor
//!
//! This tool extracts Megolm session keys from a Sled-based crypto store
//! used by the Matrix bot SDK. The extracted keys can then be uploaded
//! to a Matrix server backup for migration to SQLite storage.

use anyhow::{Context, Result};
use clap::Parser;
use matrix_sdk_crypto::olm::ExportedRoomKey;
use matrix_sdk_crypto::store::CryptoStore;
use matrix_sdk_sled::SledCryptoStore;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tracing::{info, warn, Level};
use tracing_subscriber::FmtSubscriber;

/// Extracted key data in a format suitable for Matrix backup upload
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportedKeyData {
    /// Room ID the key belongs to
    room_id: String,
    /// Session ID for this key
    session_id: String,
    /// Algorithm (usually m.megolm.v1.aes-sha2)
    algorithm: String,
    /// The actual exported key data (base64 encoded)
    session_key: String,
    /// Sender key (Curve25519)
    sender_key: String,
    /// Sender claimed keys
    sender_claimed_keys: std::collections::HashMap<String, String>,
    /// Forwarding chain
    forwarding_curve25519_key_chain: Vec<String>,
}

/// Output format for the extracted keys
#[derive(Debug, Serialize, Deserialize)]
struct ExtractionOutput {
    /// Version of this export format
    version: u32,
    /// Total number of keys extracted
    total_keys: usize,
    /// Extracted keys organized by room
    keys_by_room: std::collections::HashMap<String, Vec<ExportedKeyData>>,
    /// Flat list of all keys
    all_keys: Vec<ExportedKeyData>,
}

/// CLI arguments for the key extractor
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the Sled crypto store directory
    #[arg(short, long)]
    sled_path: PathBuf,

    /// Output file path for the extracted keys JSON
    #[arg(short, long)]
    output: PathBuf,

    /// Optional passphrase if the store is encrypted
    #[arg(short, long)]
    passphrase: Option<String>,

    /// Enable verbose output
    #[arg(short, long, default_value = "false")]
    verbose: bool,
}

/// Convert an ExportedRoomKey to our serializable format
fn convert_exported_key(key: &ExportedRoomKey) -> ExportedKeyData {
    ExportedKeyData {
        room_id: key.room_id.to_string(),
        session_id: key.session_id.clone(),
        algorithm: key.algorithm.to_string(),
        session_key: key.session_key.to_base64(),
        sender_key: key.sender_key.to_base64(),
        sender_claimed_keys: key
            .sender_claimed_keys
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_base64()))
            .collect(),
        forwarding_curve25519_key_chain: key
            .forwarding_curve25519_key_chain
            .iter()
            .map(|k| k.to_base64())
            .collect(),
    }
}

/// Extract all inbound group session keys from the Sled store
async fn extract_keys(sled_path: &PathBuf, passphrase: Option<&str>) -> Result<Vec<ExportedRoomKey>> {
    info!("Opening Sled crypto store at: {:?}", sled_path);

    // Open the Sled store
    // Note: matrix-bot-sdk uses empty string "" as passphrase, not None
    let effective_passphrase = passphrase.unwrap_or("");
    info!("Using passphrase: '{}'", if effective_passphrase.is_empty() { "<empty string>" } else { "<provided>" });

    // Open sled db directly and pass to open_with_database
    let db = sled::Config::new()
        .path(sled_path)
        .open()
        .context("Failed to open sled database")?;

    let store = SledCryptoStore::open_with_database(db, Some(effective_passphrase))
        .await
        .context("Failed to open Sled crypto store")?;

    info!("Sled store opened successfully");

    // === DIAGNOSTIC: Raw sled database inspection ===
    info!("=== RAW SLED DB INSPECTION ===");
    if let Ok(raw_db) = sled::open(sled_path) {
        info!("Raw sled DB opened");
        info!("Tree names in DB:");
        for name in raw_db.tree_names() {
            let name_str = String::from_utf8_lossy(&name);
            if let Ok(tree) = raw_db.open_tree(&name) {
                info!("  Tree '{}': {} entries", name_str, tree.len());
                // Show first few keys from each tree
                let mut count = 0;
                for item in tree.iter() {
                    if let Ok((key, _)) = item {
                        let key_str = String::from_utf8_lossy(&key);
                        info!("    Key: {}", key_str);
                        count += 1;
                        if count >= 3 { break; }
                    }
                }
            }
        }
    }

    // === DIAGNOSTIC: Check account data ===
    info!("=== DIAGNOSTICS ===");
    match store.load_account().await {
        Ok(Some(account)) => {
            info!("✓ Account found!");
            info!("  User ID: {}", account.user_id());
            info!("  Device ID: {}", account.device_id());
            info!("  Identity keys present: {}", account.identity_keys().curve25519.to_base64().len() > 0);
        }
        Ok(None) => warn!("✗ No account found in store!"),
        Err(e) => warn!("✗ Error loading account: {}", e),
    }

    // === DIAGNOSTIC: Check tracked users ===
    let tracked = store.load_tracked_users().await.unwrap_or_default();
    info!("Tracking {} users", tracked.len());

    // === Get inbound group sessions ===
    info!("=== INBOUND SESSIONS ===");
    let sessions: Vec<matrix_sdk_crypto::olm::InboundGroupSession> = store
        .get_inbound_group_sessions()
        .await
        .context("Failed to retrieve inbound group sessions")?;

    info!("Found {} inbound group sessions", sessions.len());

    // Export each session
    let mut exported_keys: Vec<ExportedRoomKey> = Vec::new();

    for session in sessions.iter() {
        let exported: ExportedRoomKey = session.export().await;
        info!("  Exported session {} in room {}",
            exported.session_id,
            exported.room_id);
        exported_keys.push(exported);
    }

    info!("Successfully exported {} keys", exported_keys.len());

    Ok(exported_keys)
}

/// Organize keys by room and create the output structure
fn organize_keys(keys: Vec<ExportedRoomKey>) -> ExtractionOutput {
    let mut keys_by_room: std::collections::HashMap<String, Vec<ExportedKeyData>> =
        std::collections::HashMap::new();
    let mut all_keys = Vec::new();

    for key in keys {
        let room_id = key.room_id.to_string();
        let exported_data = convert_exported_key(&key);

        keys_by_room
            .entry(room_id)
            .or_insert_with(Vec::new)
            .push(exported_data.clone());

        all_keys.push(exported_data);
    }

    ExtractionOutput {
        version: 1,
        total_keys: all_keys.len(),
        keys_by_room,
        all_keys,
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Set up logging
    let log_level = if args.verbose {
        Level::DEBUG
    } else {
        Level::INFO
    };

    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(false)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .context("Failed to set up logging")?;

    info!("Sled Key Extractor v{}", env!("CARGO_PKG_VERSION"));
    info!("Sled path: {:?}", args.sled_path);
    info!("Output path: {:?}", args.output);

    // Verify the Sled path exists
    if !args.sled_path.exists() {
        anyhow::bail!("Sled store path does not exist: {:?}", args.sled_path);
    }

    // Extract the keys
    let keys = extract_keys(&args.sled_path, args.passphrase.as_deref()).await?;

    if keys.is_empty() {
        warn!("No keys were extracted! The store may be empty or corrupted.");
    }

    // Organize and serialize
    let output = organize_keys(keys);

    // Write to output file
    let json = serde_json::to_string_pretty(&output)
        .context("Failed to serialize keys to JSON")?;

    std::fs::write(&args.output, &json)
        .context("Failed to write output file")?;

    info!("Keys successfully exported to: {:?}", args.output);
    info!("Total keys exported: {}", output.total_keys);
    info!("Rooms with keys: {}", output.keys_by_room.len());

    // Print summary by room
    if args.verbose {
        info!("\nKeys per room:");
        for (room_id, keys) in &output.keys_by_room {
            info!("  {}: {} keys", room_id, keys.len());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extraction_output_serialization() {
        let output = ExtractionOutput {
            version: 1,
            total_keys: 0,
            keys_by_room: std::collections::HashMap::new(),
            all_keys: Vec::new(),
        };

        let json = serde_json::to_string(&output).unwrap();
        let parsed: ExtractionOutput = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.total_keys, 0);
    }
}
