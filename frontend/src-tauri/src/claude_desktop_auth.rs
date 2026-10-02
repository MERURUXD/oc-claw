//! Read-only Desktop OAuth discovery, following cc-bar's identity/scope rules.
//! Windows Electron safeStorage uses DPAPI + AES-GCM, unlike macOS's CBC store.
//! Never renew a token or write to Desktop's credential files.
use serde_json::Value;
use std::collections::HashSet;

pub struct Credentials {
    pub access_token: String,
    pub expires_at_ms: u64,
    pub account_key: String,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

const OFFICIAL_CLIENT: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// An undecryptable/expired login still establishes account ownership; it
/// must not be replaced by an unrelated session's unscoped statusline reading.
pub fn has_selected_account() -> bool {
    crate::claude_desktop::roots()
        .pop()
        .and_then(|root| crate::claude_desktop::json_file(&root.join("config.json")))
        .is_some_and(|config| {
            config["lastKnownAccountUuid"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        })
}

fn select_token(
    caches: &[Value],
    account: &str,
    organization: Option<&str>,
    now: u64,
) -> Option<Credentials> {
    let mut candidates = Vec::new();
    for cache in caches {
        for (key, value) in cache.as_object().into_iter().flatten() {
            let Some((owner, rest)) = key.strip_prefix("acct:").and_then(|k| k.split_once('|'))
            else {
                continue;
            };
            if !owner.eq_ignore_ascii_case(account) {
                continue;
            }
            let mut parts = rest.splitn(3, ':');
            let (Some(client), Some(org), Some(audience_scopes)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let Some(scopes) = audience_scopes.strip_prefix("https://api.anthropic.com:") else {
                continue;
            };
            if org.is_empty()
                || organization.is_some_and(|expected| !expected.eq_ignore_ascii_case(org))
                || !scopes
                    .trim_end_matches(':')
                    .split_ascii_whitespace()
                    .any(|s| s == "user:profile")
            {
                continue;
            }
            let Some(token) = value["token"].as_str().filter(|t| !t.trim().is_empty()) else {
                continue;
            };
            let Some(mut expiry) = value["expiresAt"].as_u64() else {
                continue;
            };
            if expiry < 10_000_000_000 {
                expiry = expiry.saturating_mul(1000);
            }
            if expiry <= now.saturating_mul(1000).saturating_add(30_000) {
                continue;
            }
            candidates.push((
                client == OFFICIAL_CLIENT,
                expiry,
                org.to_ascii_lowercase(),
                value,
                token,
            ));
        }
    }
    // A single quota card cannot choose among multiple organizations silently.
    let orgs: HashSet<_> = candidates.iter().map(|c| &c.2).collect();
    if orgs.len() != 1 {
        return None;
    }
    let (_, expiry, org, value, token) = candidates.into_iter().max_by_key(|c| (c.0, c.1))?;
    Some(Credentials {
        access_token: token.to_owned(),
        expires_at_ms: expiry,
        account_key: format!("desktop:{}:{org}", account.to_ascii_lowercase()),
        subscription_type: value["subscriptionType"].as_str().map(str::to_owned),
        rate_limit_tier: value["rateLimitTier"].as_str().map(str::to_owned),
    })
}

/// With an existing CLI login, both IDs must be supplied by its account metadata.
/// Without one, use Desktop's selected account and require an unambiguous org.
pub fn read_credentials(expected: Option<(&str, &str)>, now: u64) -> Option<Credentials> {
    use base64::Engine;
    let root = crate::claude_desktop::roots().pop()?;
    let config = crate::claude_desktop::json_file(&root.join("config.json"))?;
    let account = expected
        .map(|e| e.0)
        .or_else(|| config["lastKnownAccountUuid"].as_str())?;
    if account.is_empty() {
        return None;
    }
    let mut caches = Vec::new();
    for name in ["oauth:tokenCacheV2", "oauth:tokenCache"] {
        let Some(encoded) = config[name].as_str() else {
            continue;
        };
        let Ok(blob) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            continue;
        };
        let Some(mut plaintext) = decrypt(&root, &blob) else {
            continue;
        };
        if let Ok(value) = serde_json::from_slice(&plaintext) {
            caches.push(value);
        }
        plaintext.fill(0);
    }
    select_token(&caches, account, expected.map(|e| e.1), now)
}

#[cfg(not(windows))]
fn decrypt(_root: &std::path::Path, _blob: &[u8]) -> Option<Vec<u8>> {
    // Existing CLI Keychain/file and passive Desktop paths remain available.
    // macOS requires a dedicated noninteractive Keychain/CBC adapter.
    None
}

#[cfg(windows)]
fn decrypt(root: &std::path::Path, blob: &[u8]) -> Option<Vec<u8>> {
    use base64::Engine;
    if !blob.starts_with(b"v10") && !blob.starts_with(b"v11") {
        return windows_crypto::unprotect(blob);
    }
    let state = crate::claude_desktop::json_file(&root.join("Local State"))?;
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(state["os_crypt"]["encrypted_key"].as_str()?)
        .ok()?;
    let mut key = windows_crypto::unprotect(encrypted.strip_prefix(b"DPAPI")?)?;
    let result = windows_crypto::aes_gcm(&key, blob);
    key.fill(0);
    result
}

#[cfg(windows)]
mod windows_crypto {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::*;

    pub(super) fn unprotect(bytes: &[u8]) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len().try_into().ok()?,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // UI forbidden; never prompt or change the protection on disk.
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .ok()?;
            if output.pbData.is_null() {
                return None;
            }
            let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
            let _ = LocalFree(HLOCAL(output.pbData.cast()));
            Some(result)
        }
    }

    struct Algorithm(BCRYPT_ALG_HANDLE);
    impl Drop for Algorithm {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptCloseAlgorithmProvider(self.0, 0);
            }
        }
    }
    struct Key(BCRYPT_KEY_HANDLE);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = BCryptDestroyKey(self.0);
            }
        }
    }

    pub(super) fn aes_gcm(secret: &[u8], blob: &[u8]) -> Option<Vec<u8>> {
        if secret.len() != 32 || blob.len() < 31 {
            return None;
        }
        let (ciphertext, tag) = blob[15..].split_at(blob.len() - 31);
        let mut nonce = blob[3..15].to_vec();
        let mut tag = tag.to_vec();
        unsafe {
            let mut alg = BCRYPT_ALG_HANDLE::default();
            BCryptOpenAlgorithmProvider(
                &mut alg,
                BCRYPT_AES_ALGORITHM,
                None,
                BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0),
            )
            .ok()
            .ok()?;
            let alg = Algorithm(alg);
            let mode: Vec<u8> = "ChainingModeGCM\0"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            BCryptSetProperty(alg.0.into(), BCRYPT_CHAINING_MODE, &mode, 0)
                .ok()
                .ok()?;
            let mut key = BCRYPT_KEY_HANDLE::default();
            BCryptGenerateSymmetricKey(alg.0, &mut key, None, secret, 0)
                .ok()
                .ok()?;
            let key = Key(key);
            let info = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
                cbSize: std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32,
                dwInfoVersion: 1,
                pbNonce: nonce.as_mut_ptr(),
                cbNonce: nonce.len() as u32,
                pbTag: tag.as_mut_ptr(),
                cbTag: tag.len() as u32,
                ..Default::default()
            };
            let mut out = vec![0; ciphertext.len()];
            let mut size = 0;
            let status = BCryptDecrypt(
                key.0,
                Some(ciphertext),
                Some((&info as *const BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO).cast()),
                None,
                Some(&mut out),
                &mut size,
                BCRYPT_FLAGS(0),
            );
            if status.is_err() {
                out.fill(0);
                return None;
            }
            out.truncate(size as usize);
            Some(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cache(
        account: &str,
        client: &str,
        org: &str,
        scope: &str,
        token: &str,
        expiry: u64,
    ) -> Value {
        json!({format!("acct:{account}|{client}:{org}:https://api.anthropic.com:{scope}:"): {"token":token,"expiresAt":expiry,"refreshToken":"must-never-be-used"}})
    }

    #[test]
    fn matches_both_ids_and_never_borrows_another_selected_account() {
        let caches = [
            cache("a", OFFICIAL_CLIENT, "org", "user:profile", "a", 2000),
            cache("b", OFFICIAL_CLIENT, "org", "user:profile", "b", 5000),
        ];
        assert_eq!(
            select_token(&caches, "A", Some("ORG"), 1000)
                .unwrap()
                .access_token,
            "a"
        );
        assert!(select_token(&caches, "c", None, 1000).is_none());
        assert!(select_token(&caches, "a", Some("wrong"), 1000).is_none());
    }

    #[test]
    fn requires_exact_scope_audience_expiry_and_unambiguous_organization() {
        for (scope, expiry) in [
            ("user:inference", 2000),
            ("user:profile-extra", 2000),
            ("user:profile", 1030),
        ] {
            assert!(select_token(
                &[cache("a", "client", "o", scope, "t", expiry)],
                "a",
                None,
                1000
            )
            .is_none());
        }
        let one = cache("a", "c", "one", "user:profile", "t", 2000);
        let two = cache("a", "c", "two", "user:profile", "t", 2000);
        assert!(select_token(&[one.clone(), two], "a", None, 1000).is_none());
        let wrong = one
            .to_string()
            .replace("api.anthropic.com", "other.example");
        assert!(select_token(&[serde_json::from_str(&wrong).unwrap()], "a", None, 1000).is_none());
    }

    #[test]
    fn prefers_official_client_and_normalizes_seconds_and_milliseconds() {
        let caches = [
            cache("a", "other", "o", "user:profile", "other", 9_000_000_000),
            cache(
                "a",
                OFFICIAL_CLIENT,
                "o",
                "user:profile user:inference",
                "official",
                1_800_000_000_000,
            ),
        ];
        let c = select_token(&caches, "a", None, 1_700_000_000).unwrap();
        assert_eq!(c.access_token, "official");
        assert_eq!(c.expires_at_ms, 1_800_000_000_000);
        assert_eq!(c.account_key, "desktop:a:o");
    }

    #[cfg(windows)]
    #[test]
    fn gcm_authenticates_ciphertext_and_rejects_corruption() {
        // NIST AES-256-GCM vector: zero key/nonce, one zero plaintext block.
        let mut blob = b"v10".to_vec();
        blob.extend([0; 12]);
        blob.extend([
            0xce, 0xa7, 0x40, 0x3d, 0x4d, 0x60, 0x6b, 0x6e, 0x07, 0x4e, 0xc5, 0xd3, 0xba, 0xf3,
            0x9d, 0x18, 0xd0, 0xd1, 0xc8, 0xa7, 0x99, 0x99, 0x6b, 0xf0, 0x26, 0x5b, 0x98, 0xb5,
            0xd4, 0x8a, 0xb9, 0x19,
        ]);
        assert_eq!(windows_crypto::aes_gcm(&[0; 32], &blob), Some(vec![0; 16]));
        blob[20] ^= 1;
        assert!(windows_crypto::aes_gcm(&[0; 32], &blob).is_none());
        assert!(windows_crypto::aes_gcm(&[0; 16], &blob).is_none());
        assert!(windows_crypto::aes_gcm(&[0; 32], b"v10").is_none());
    }
}
