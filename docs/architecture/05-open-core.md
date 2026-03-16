# Harmony — Open Core & Business Model

> **Model:** GitLab-style Open Core
> **License (CE):** AGPL-3.0
> **License (EE):** Proprietary

---

## 1. What is Open Core?

One codebase, two editions:

- **Community Edition (CE):** Fully open source. Anyone can use, modify, and deploy it for free.
- **Enterprise Edition (EE):** CE + proprietary modules that require a license key. Targeted at businesses.

Revenue comes from selling **convenience** (hosted SaaS) and **compliance** (enterprise features), NOT user data.

---

## 2. Revenue Streams

### Stream 1: Harmony Cloud (SaaS) — Primary Revenue

"We host it for you."

| Plan | Price | What you get |
|------|-------|-------------|
| **Free** | $0 | 1 server, 100 members max, 100MB storage, 7-day message history |
| **Pro** | $5/month per server | Unlimited members, 5GB storage, full history, priority routing |
| **Business** | $15/month per server | All Pro + SSO, audit logs, data export, SLA |

### Stream 2: Enterprise License (Self-Hosted) — Secondary Revenue

For companies self-hosting Harmony on their own infrastructure.

| License | Price | What you get |
|---------|-------|-------------|
| **Enterprise** | $500/year (up to 50 users) | SSO (SAML/OIDC), advanced audit logs, compliance export, priority support |
| **Enterprise+** | Custom pricing | Dedicated support, custom integrations, SLA |

### Stream 3: Patron (Cosmetics) — Supplementary

For individual users on Harmony Cloud who want to support the project.

| Tier | Price | Perks |
|------|-------|-------|
| **Supporter** | $3/month | Animated avatar, profile badge, custom theme colors |
| **Champion** | $7/month | All Supporter + global custom emoji, higher upload limit (50MB) |

---

## 3. Feature Matrix

| Feature | CE (Free) | Cloud Free | Cloud Pro | Cloud Business / EE |
|---------|-----------|------------|-----------|---------------------|
| Text chat | Yes | Yes | Yes | Yes |
| Voice/Video | Yes | Yes | Yes | Yes |
| File uploads | Yes (configurable) | 100MB | 5GB | Configurable |
| Message history | Unlimited | 7 days | Unlimited | Unlimited |
| Servers | Unlimited | 1 | Unlimited | Unlimited |
| Members per server | Unlimited | 100 | Unlimited | Unlimited |
| Roles & permissions | Yes | Yes | Yes | Yes |
| Custom emoji | Yes | Yes | Yes | Yes |
| Markdown + code blocks | Yes | Yes | Yes | Yes |
| SSO (SAML/OIDC) | No | No | No | **Yes** |
| Audit logs (advanced) | No | No | No | **Yes** |
| Compliance data export | No | No | No | **Yes** |
| Data retention policies | No | No | No | **Yes** |
| Priority support | No | No | No | **Yes** |
| White-label / custom branding | No | No | No | **Yes** |
| SLA guarantee | No | No | No | **Yes** |

---

## 4. Technical Implementation

### Repository Structure

```
harmony/
├── harmony-api/                    # CE — 100% Open Source (AGPL-3.0)
│   ├── src/
│   │   ├── domain/                 # All core business logic
│   │   ├── infra/
│   │   └── api/
│   └── Cargo.toml
│
├── harmony-enterprise/             # EE — Proprietary (separate crate)
│   ├── src/
│   │   ├── sso/                    # SAML/OIDC integration
│   │   ├── audit/                  # Advanced audit logging
│   │   ├── compliance/             # Data export, retention policies
│   │   ├── license.rs              # License key validation
│   │   └── lib.rs                  # EE route extensions
│   └── Cargo.toml                  # Depends on harmony-api as a lib
│
├── harmony-app/                    # CE — 100% Open Source
└── supabase/                       # CE — migrations
```

### How EE Extends CE

The Enterprise crate imports `harmony-api` as a library and adds routes:

```rust
// harmony-enterprise/src/lib.rs

use harmony_api::api::state::AppState;
use axum::Router;

pub fn enterprise_routes(state: &AppState) -> Option<Router<AppState>> {
    // Check license validity
    let license = match validate_license(&state.config.license_key) {
        Ok(license) => license,
        Err(_) => return None, // No valid license → no EE routes
    };

    let routes = Router::new();

    if license.has_feature("sso") {
        routes = routes.merge(sso::routes());
    }
    if license.has_feature("audit") {
        routes = routes.merge(audit::routes());
    }

    Some(routes)
}
```

```rust
// harmony-enterprise/src/main.rs (EE binary)

#[tokio::main]
async fn main() {
    let state = harmony_api::build_state().await;

    let mut app = harmony_api::build_router(state.clone());

    // Extend with enterprise features if licensed
    if let Some(ee_routes) = harmony_enterprise::enterprise_routes(&state) {
        app = app.nest("/v1", ee_routes);
    }

    // ... serve
}
```

### Docker Images

```
# CE image (public)
docker pull ghcr.io/harmony-app/harmony:latest

# EE image (restricted registry or built from private repo)
docker pull registry.harmony.app/harmony-enterprise:latest
```

### License Key Validation

```rust
// harmony-enterprise/src/license.rs

pub struct License {
    pub organization: String,
    pub max_users: u32,
    pub features: Vec<String>,     // ["sso", "audit", "compliance"]
    pub expires_at: DateTime<Utc>,
}

pub fn validate_license(key: &Option<Secret<String>>) -> Result<License, LicenseError> {
    let key = key.as_ref().ok_or(LicenseError::Missing)?;

    // Decode and verify signature (Ed25519 signed JWT or similar)
    let license: License = decode_and_verify(key.expose_secret())?;

    if license.expires_at < Utc::now() {
        return Err(LicenseError::Expired);
    }

    Ok(license)
}
```

License keys are JWT-like tokens signed with Harmony's private key. The public key is embedded in the EE binary. No "phone home" required (works offline).

---

## 5. Licensing Strategy

### Why AGPL-3.0 for CE?

- **AGPL** requires that anyone who runs a modified version of the software over a network must release their source code
- This prevents competitors from taking your code, modifying it, and offering it as a closed-source SaaS without contributing back
- GitLab uses the same strategy (MIT → EE/proprietary for paid features, was previously CE under MIT then moved to a more protective model)

### What about the frontend (Tauri app)?

- The Tauri app is also AGPL-3.0
- Since it's a desktop app (not a network service), AGPL effectively behaves like GPL for end users
- Users can modify the client freely for personal use

---

## 6. Pricing Philosophy

1. **Core features are ALWAYS free.** Chat, voice, video, roles — free forever. Never paywall core communication.
2. **Charge for enterprise needs.** SSO, audit logs, compliance — things individuals don't need but companies require.
3. **Charge for convenience.** Hosting, backups, scaling — things self-hosters do for free but busy teams pay to avoid.
4. **Cosmetics are optional.** Animated avatars, badges — revenue supplement, never a requirement.

---

## 7. Build Sequence

1. **Now:** Build CE only. Don't create the `harmony-enterprise` crate yet.
2. **Phase 2:** Ship the SaaS (Harmony Cloud) on your infrastructure. Revenue starts.
3. **Phase 3:** When enterprise customers ask for SSO/audit, create the EE crate.
4. **Phase 4:** Sell EE licenses + Patron subscriptions.

Do not build EE features before you have paying customers asking for them.
