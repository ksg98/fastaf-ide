use std::sync::Arc;

use anyhow::{Context, Result};
use base64ct::{Base64UrlUnpadded, Encoding};
use tracing::{info, warn};
use web_push_native::p256::ecdsa::{signature::Signer, Signature, SigningKey};
use web_push_native::{p256, Auth, WebPushBuilder};

use crate::types::PushSubscription;

/// VAPID configuration for sending Web Push notifications.
#[derive(Clone)]
pub struct VapidConfig {
    /// ES256 key pair for VAPID signing.
    signing_key: Arc<SigningKey>,
    /// Contact URI (mailto: or https:) for the VAPID subject claim.
    subject: String,
}

impl VapidConfig {
    /// Create from a base64url-encoded ES256 private key and a subject URI.
    pub fn new(private_key_base64: &str, subject: &str) -> Result<Self> {
        let key_bytes = Base64UrlUnpadded::decode_vec(private_key_base64)
            .map_err(|e| anyhow::anyhow!("invalid base64url VAPID key: {e}"))?;
        let secret_key = p256::SecretKey::from_slice(&key_bytes)
            .map_err(|e| anyhow::anyhow!("invalid ES256 private key: {e}"))?;
        Ok(Self {
            signing_key: Arc::new(SigningKey::from(&secret_key)),
            subject: subject.to_owned(),
        })
    }

    /// Get the VAPID public key as base64url-encoded uncompressed bytes
    /// (the value clients need for `applicationServerKey` in `pushManager.subscribe`).
    pub fn public_key_base64(&self) -> String {
        let public = self.signing_key.verifying_key().to_encoded_point(false);
        Base64UrlUnpadded::encode_string(public.as_bytes())
    }
}

/// Build an RFC 8292 VAPID authorization header without jwt-simple's
/// transitive RSA backend. VAPID itself only requires an ES256 signature.
fn build_vapid_authorization(
    signing_key: &SigningKey,
    endpoint: &http::Uri,
    subject: &str,
    valid_secs: u64,
) -> Result<http::HeaderValue> {
    let jwt_header = Base64UrlUnpadded::encode_string(br#"{"alg":"ES256","typ":"JWT"}"#);
    let expiration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + valid_secs;
    let audience = format!(
        "{}://{}",
        endpoint.scheme_str().context("endpoint missing scheme")?,
        endpoint.host().context("endpoint missing host")?,
    );
    let claims = serde_json::to_vec(&serde_json::json!({
        "aud": audience,
        "exp": expiration,
        "sub": subject,
    }))
    .context("failed to serialize VAPID claims")?;
    let jwt_claims = Base64UrlUnpadded::encode_string(&claims);
    let signing_input = format!("{jwt_header}.{jwt_claims}");
    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let jwt_signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
    let public = Base64UrlUnpadded::encode_string(
        signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );

    http::HeaderValue::try_from(format!(
        "vapid t={signing_input}.{jwt_signature}, k={public}"
    ))
    .context("invalid VAPID authorization header")
}

/// Parse browser push subscription fields into typed values for WebPushBuilder.
fn parse_subscription(sub: &PushSubscription) -> Result<(http::Uri, p256::PublicKey, Auth)> {
    let endpoint: http::Uri = sub.endpoint.parse().context("invalid push endpoint URL")?;
    let p256dh_bytes =
        Base64UrlUnpadded::decode_vec(&sub.keys.p256dh).context("invalid p256dh base64url")?;
    let ua_public = p256::PublicKey::from_sec1_bytes(&p256dh_bytes)
        .map_err(|e| anyhow::anyhow!("invalid p256dh public key: {e}"))?;
    let auth_bytes =
        Base64UrlUnpadded::decode_vec(&sub.keys.auth).context("invalid auth base64url")?;
    anyhow::ensure!(
        auth_bytes.len() == 16,
        "invalid auth secret length: expected 16 bytes, got {}",
        auth_bytes.len()
    );
    let ua_auth = Auth::clone_from_slice(&auth_bytes);
    Ok((endpoint, ua_public, ua_auth))
}

/// Build an HTTP request for a Web Push notification.
pub fn build_push_request(
    vapid: &VapidConfig,
    sub: &PushSubscription,
    payload: &[u8],
) -> Result<http::Request<Vec<u8>>> {
    let (endpoint, ua_public, ua_auth) = parse_subscription(sub)?;
    let authorization =
        build_vapid_authorization(&vapid.signing_key, &endpoint, &vapid.subject, 12 * 60 * 60)?;
    let mut request = WebPushBuilder::new(endpoint, ua_public, ua_auth)
        .build(payload.to_vec())
        .map_err(|e| anyhow::anyhow!("web push build error: {e}"))?;
    request
        .headers_mut()
        .insert(http::header::AUTHORIZATION, authorization);
    Ok(request)
}

/// Send a Web Push notification to a single subscription.
/// Returns `Ok(true)` if sent, `Ok(false)` if the endpoint is gone (caller should delete sub).
pub async fn send_push(
    client: &reqwest::Client,
    vapid: &VapidConfig,
    sub: &PushSubscription,
    payload: &[u8],
) -> Result<bool> {
    let request = match build_push_request(vapid, sub, payload) {
        Ok(r) => r,
        Err(e) => {
            warn!(endpoint = %sub.endpoint, error = %e, "failed to build push request");
            return Ok(false);
        }
    };

    let (parts, body) = request.into_parts();
    let mut reqwest_request = client.request(parts.method, parts.uri.to_string());
    for (name, value) in &parts.headers {
        reqwest_request = reqwest_request.header(name, value);
    }

    let response = reqwest_request.body(body).send().await?;
    let status = response.status();

    if status.is_success() {
        info!(endpoint = %sub.endpoint, "push notification sent");
        Ok(true)
    } else if status == reqwest::StatusCode::GONE || status == reqwest::StatusCode::NOT_FOUND {
        info!(endpoint = %sub.endpoint, %status, "push endpoint gone");
        Ok(false)
    } else {
        let body = response.text().await.unwrap_or_default();
        warn!(endpoint = %sub.endpoint, %status, %body, "push notification failed");
        Ok(true) // keep subscription, might be transient
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    /// Generate a throwaway VAPID key pair, return base64url-encoded private key.
    fn generate_vapid_key_base64() -> String {
        let key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        Base64UrlUnpadded::encode_string(&key.to_bytes())
    }

    /// Generate a fake browser subscription with valid crypto keys.
    fn fake_subscription() -> PushSubscription {
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let public = secret.public_key();
        let p256dh =
            Base64UrlUnpadded::encode_string(public.as_affine().to_encoded_point(false).as_bytes());
        let auth = Base64UrlUnpadded::encode_string(&[0u8; 16]);

        PushSubscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/fake-id".to_string(),
            keys: crate::types::PushSubscriptionKeys { p256dh, auth },
        }
    }

    #[test]
    fn vapid_config_from_base64() {
        let b64 = generate_vapid_key_base64();
        let config = VapidConfig::new(&b64, "mailto:test@example.com").unwrap();
        let pub_key = config.public_key_base64();
        assert!(!pub_key.is_empty());
    }

    #[test]
    fn vapid_config_rejects_invalid_key() {
        let result = VapidConfig::new("not-a-valid-key", "mailto:test@example.com");
        assert!(result.is_err());
    }

    #[test]
    fn vapid_authorization_contains_verifiable_es256_jwt() {
        let key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let endpoint: http::Uri = "https://fcm.googleapis.com/fcm/send/test".parse().unwrap();
        let header =
            build_vapid_authorization(&key, &endpoint, "mailto:test@example.com", 3600).unwrap();
        let value = header.to_str().unwrap();
        let jwt = value
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let parts: Vec<_> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);

        let header_json: serde_json::Value =
            serde_json::from_slice(&Base64UrlUnpadded::decode_vec(parts[0]).unwrap()).unwrap();
        assert_eq!(header_json["alg"], "ES256");
        assert_eq!(header_json["typ"], "JWT");

        let claims: serde_json::Value =
            serde_json::from_slice(&Base64UrlUnpadded::decode_vec(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:test@example.com");

        let signature =
            Signature::from_slice(&Base64UrlUnpadded::decode_vec(parts[2]).unwrap()).unwrap();
        key.verifying_key()
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn build_push_request_produces_valid_http() {
        let b64 = generate_vapid_key_base64();
        let config = VapidConfig::new(&b64, "mailto:test@example.com").unwrap();
        let sub = fake_subscription();

        let request = build_push_request(&config, &sub, b"test payload").unwrap();
        assert_eq!(request.method(), http::Method::POST);
        assert!(request
            .uri()
            .to_string()
            .starts_with("https://fcm.googleapis.com/"));
        assert!(request.headers().contains_key("authorization"));
        assert!(request.headers()["authorization"]
            .to_str()
            .unwrap()
            .starts_with("vapid t="));
        assert!(!request.body().is_empty());
    }

    #[test]
    fn build_push_request_rejects_bad_subscription() {
        let b64 = generate_vapid_key_base64();
        let config = VapidConfig::new(&b64, "mailto:test@example.com").unwrap();
        let sub = PushSubscription {
            endpoint: "https://push.example.com/sub".to_string(),
            keys: crate::types::PushSubscriptionKeys {
                p256dh: "invalid!!!".to_string(),
                auth: "also-invalid".to_string(),
            },
        };

        let result = build_push_request(&config, &sub, b"test");
        assert!(result.is_err());
    }

    #[test]
    fn build_push_request_rejects_wrong_auth_length() {
        let b64 = generate_vapid_key_base64();
        let config = VapidConfig::new(&b64, "mailto:test@example.com").unwrap();
        let mut sub = fake_subscription();
        sub.keys.auth = Base64UrlUnpadded::encode_string(&[0u8; 15]);

        let result = build_push_request(&config, &sub, b"test");
        assert!(result.is_err());
    }
}
