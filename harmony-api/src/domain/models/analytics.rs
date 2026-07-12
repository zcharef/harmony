//! Analytics funnel events (growth-plan §10).
//!
//! Privacy contract: events carry IDs and small flag bags ONLY — never
//! message content, IP addresses, user agents, or any other PII. The
//! `user_signed_up` event is emitted by a DB trigger on profile creation
//! (the one funnel point the API does not own) and is therefore absent
//! from this enum.

use std::fmt;

use serde_json::Value;

use crate::domain::models::{ChannelId, Plan, ResourceKind, ServerId, UserId};

/// Stable analytics event names (§10: "stable event names").
///
/// WHY an enum instead of strings: a typo'd event name silently fragments
/// funnel data; the compiler is the cheapest guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalyticsEventName {
    /// A user created a server (activation funnel: owner path).
    ServerCreated,
    /// A user joined a server (invite redemption or official auto-join).
    ServerJoined,
    /// A user sent their very first message (once per user, DB-deduped).
    FirstMessage,
    /// A member created an invite (referral funnel: K-factor numerator).
    InviteCreated,
    /// An invite preview was rendered pre-auth (funnel top: landing views).
    /// Carries server id + a truncated code hash — never the raw code
    /// (a join capability) and never the viewer's IP.
    InviteViewed,
    /// A user joined a server through an invite (K-factor conversion).
    InviteRedeemed,
    /// A join-via-invite by an account created moments earlier — the invite
    /// drove the signup (referral attribution). Once per user (DB-deduped).
    SignupViaInvite,
    /// A user joined a voice channel (WCU + retention meaningful action).
    VoiceJoined,
    /// A user added a reaction (retention meaningful action).
    ReactionAdded,
    /// A user opened an SSE connection (traffic signal; NOT retention).
    SessionConnected,
    /// A user opened the server directory (first page, discovery funnel).
    DiscoveryViewed,
    /// A user joined a server through the directory's one-click join.
    DiscoveryJoin,
    /// The API rejected an action on a plan gate (monetization funnel top).
    /// Emitted server-side at the rejection site — counts every hit even
    /// when no client ever renders the paywall.
    PlanLimitHit,
    /// The upgrade paywall was shown to a user (client-emitted).
    PaywallViewed,
    /// The paywall's upgrade CTA was clicked (client-emitted) — the
    /// Stripe-readiness signal.
    PaywallCtaClicked,
    /// The paywall was dismissed without upgrading (client-emitted).
    PaywallDismissed,
}

impl AnalyticsEventName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ServerCreated => "server_created",
            Self::ServerJoined => "server_joined",
            Self::FirstMessage => "first_message",
            Self::InviteCreated => "invite_created",
            Self::InviteViewed => "invite_viewed",
            Self::InviteRedeemed => "invite_redeemed",
            Self::SignupViaInvite => "signup_via_invite",
            Self::VoiceJoined => "voice_joined",
            Self::ReactionAdded => "reaction_added",
            Self::SessionConnected => "session_connected",
            Self::DiscoveryViewed => "discovery_viewed",
            Self::DiscoveryJoin => "discovery_join",
            Self::PlanLimitHit => "plan_limit_hit",
            Self::PaywallViewed => "paywall_viewed",
            Self::PaywallCtaClicked => "paywall_cta_clicked",
            Self::PaywallDismissed => "paywall_dismissed",
        }
    }
}

impl fmt::Display for AnalyticsEventName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One append-only funnel event row.
#[derive(Debug, Clone)]
pub struct AnalyticsEvent {
    pub name: AnalyticsEventName,
    pub user_id: Option<UserId>,
    pub server_id: Option<ServerId>,
    pub channel_id: Option<ChannelId>,
    /// Small JSON bag of IDs/flags (e.g. `{"via":"invite"}`). Never PII.
    pub properties: Value,
}

impl AnalyticsEvent {
    #[must_use]
    pub fn new(name: AnalyticsEventName) -> Self {
        Self {
            name,
            user_id: None,
            server_id: None,
            channel_id: None,
            properties: Value::Object(serde_json::Map::new()),
        }
    }

    /// Build a `plan_limit_hit` funnel event for a plan-gate rejection.
    ///
    /// WHY a shared constructor: every rejection site (the plan-limit checker
    /// and the atomic voice gate inside `upsert_with_limit`) must emit an
    /// identical event shape. The `code` mirrors the client's plan-gate
    /// contract — `limit == 0` means the feature is not in the plan at all,
    /// a distinct funnel signal from an exhausted nonzero allowance.
    /// Centralizing it here keeps the emitters from ever diverging.
    #[must_use]
    pub fn plan_limit_hit(resource: ResourceKind, plan: Plan, limit: u64) -> Self {
        let code = if limit == 0 {
            "FEATURE_NOT_IN_PLAN"
        } else {
            "PLAN_LIMIT_REACHED"
        };
        Self::new(AnalyticsEventName::PlanLimitHit).properties(serde_json::json!({
            "resource": resource.key(),
            "code": code,
            "plan": plan.as_str(),
            "limit": limit,
        }))
    }

    #[must_use]
    pub fn user(mut self, user_id: UserId) -> Self {
        self.user_id = Some(user_id);
        self
    }

    #[must_use]
    pub fn server(mut self, server_id: ServerId) -> Self {
        self.server_id = Some(server_id);
        self
    }

    #[must_use]
    pub fn channel(mut self, channel_id: ChannelId) -> Self {
        self.channel_id = Some(channel_id);
        self
    }

    #[must_use]
    pub fn properties(mut self, properties: Value) -> Self {
        self.properties = properties;
        self
    }
}
