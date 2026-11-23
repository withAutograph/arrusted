use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::signature::{UnparsedPublicKey, ED25519};

#[test]
fn shared_activation_grant_ed25519_vector() {
    let fixture = include_str!("../../contracts/__fixtures__/activation-grant-v1.txt");
    let mut lines = fixture.lines();
    let public_hex = lines
        .next()
        .expect("public key")
        .strip_prefix("public_key_hex=")
        .expect("public key label");
    let public_key: Vec<u8> = public_hex
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex pair"), 16).expect("hex")
        })
        .collect();
    let token = lines
        .next()
        .expect("token")
        .strip_prefix("token=")
        .expect("token label");
    let mut parts = token.split('.');
    assert_eq!(parts.next(), Some("ig1"));
    let payload = parts.next().expect("payload");
    let signature = URL_SAFE_NO_PAD
        .decode(parts.next().expect("signature"))
        .expect("base64url signature");
    assert!(parts.next().is_none());
    let message = format!("ig1.{payload}");
    let key = UnparsedPublicKey::new(&ED25519, public_key);
    key.verify(message.as_bytes(), &signature)
        .expect("TypeScript-issued vector must verify in Rust");
    let changed = format!("ig1.{payload}A");
    assert!(key.verify(changed.as_bytes(), &signature).is_err());
}
