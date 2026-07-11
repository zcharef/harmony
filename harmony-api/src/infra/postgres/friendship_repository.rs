//! `PostgreSQL` adapter for friendship + block persistence.

use async_trait::async_trait;
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::errors::DomainError;
use crate::domain::models::friendship::{
    BlockOutcome, BlockedUserRow, FriendRequestRow, FriendRow, Friendship, FriendshipStatus,
    RequestDirection, RequestOutcome,
};
use crate::domain::models::{ChannelId, UserId};
use crate::domain::ports::FriendshipRepository;
use crate::domain::services::friendship_service::{
    ExistingRequest, MAX_FRIENDS, resolve_request_transition,
};

/// PostgreSQL-backed friendship repository.
#[derive(Debug, Clone)]
pub struct PgFriendshipRepository {
    pool: PgPool,
}

impl PgFriendshipRepository {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

/// Canonical pair key for the advisory lock (ordered so both directions map to
/// the same lock, exactly like `PgDmRepository::create_dm`).
fn pair_key(a: Uuid, b: Uuid) -> String {
    let (low, high) = if a <= b { (a, b) } else { (b, a) };
    format!("{low}:{high}")
}

fn parse_status(value: &str) -> FriendshipStatus {
    match value {
        "accepted" => FriendshipStatus::Accepted,
        _ => FriendshipStatus::Pending,
    }
}

#[async_trait]
impl FriendshipRepository for PgFriendshipRepository {
    async fn create_request(
        &self,
        requester: &UserId,
        addressee: &UserId,
    ) -> Result<RequestOutcome, DomainError> {
        let caller = requester.0;
        let target = addressee.0;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // Serialize the whole pair transition — mirrors create_dm (§3.2): two
        // concurrent mutual requests must resolve to exactly one accepted row.
        sqlx::query!(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            pair_key(caller, target)
        )
        .execute(&mut *tx)
        .await
        .map_err(super::db_err)?;

        // Block in either direction → abort (checked under the lock; the service
        // also checks earlier, this closes the block-vs-request race).
        let blocked = sqlx::query!(
            r#"SELECT EXISTS(
                SELECT 1 FROM user_blocks
                WHERE (blocker_id = $1 AND blocked_id = $2)
                   OR (blocker_id = $2 AND blocked_id = $1)
            ) AS "blocked!""#,
            caller,
            target,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;
        if blocked.blocked {
            return Err(DomainError::Forbidden(
                "Cannot send a friend request to this user".to_string(),
            ));
        }

        let existing = sqlx::query!(
            r#"SELECT requester_id, status
               FROM friendships
               WHERE (requester_id = $1 AND addressee_id = $2)
                  OR (requester_id = $2 AND addressee_id = $1)
               FOR UPDATE"#,
            caller,
            target,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        let existing = existing.map(|row| ExistingRequest {
            requester_id: UserId::new(row.requester_id),
            status: parse_status(&row.status),
        });

        let outcome = resolve_request_transition(requester, addressee, existing.as_ref())?;

        match outcome {
            RequestOutcome::Requested => {
                sqlx::query!(
                    r#"INSERT INTO friendships (requester_id, addressee_id, status)
                       VALUES ($1, $2, 'pending')"#,
                    caller,
                    target,
                )
                .execute(&mut *tx)
                .await
                .map_err(super::db_err)?;
            }
            RequestOutcome::AutoAccepted => {
                // Both sides gain a friend — enforce each side's cap under the lock.
                let counts = sqlx::query!(
                    r#"SELECT
                        (SELECT COUNT(*)::BIGINT FROM friendships
                         WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)) AS "caller!",
                        (SELECT COUNT(*)::BIGINT FROM friendships
                         WHERE status = 'accepted' AND (requester_id = $2 OR addressee_id = $2)) AS "other!""#,
                    caller,
                    target,
                )
                .fetch_one(&mut *tx)
                .await
                .map_err(super::db_err)?;
                if counts.caller >= MAX_FRIENDS || counts.other >= MAX_FRIENDS {
                    return Err(DomainError::Conflict("Friends list is full".to_string()));
                }

                sqlx::query!(
                    r#"UPDATE friendships
                       SET status = 'accepted', updated_at = now()
                       WHERE (requester_id = $1 AND addressee_id = $2)
                          OR (requester_id = $2 AND addressee_id = $1)"#,
                    caller,
                    target,
                )
                .execute(&mut *tx)
                .await
                .map_err(super::db_err)?;
            }
            RequestOutcome::AlreadyRequested | RequestOutcome::AlreadyFriends => {}
        }

        tx.commit().await.map_err(super::db_err)?;
        Ok(outcome)
    }

    async fn accept_request(
        &self,
        caller: &UserId,
        requester: &UserId,
    ) -> Result<Friendship, DomainError> {
        let addressee = caller.0;
        let req = requester.0;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        // Both sides gain a friend — enforce each side's cap.
        let counts = sqlx::query!(
            r#"SELECT
                (SELECT COUNT(*)::BIGINT FROM friendships
                 WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)) AS "caller!",
                (SELECT COUNT(*)::BIGINT FROM friendships
                 WHERE status = 'accepted' AND (requester_id = $2 OR addressee_id = $2)) AS "other!""#,
            addressee,
            req,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(super::db_err)?;
        if counts.caller >= MAX_FRIENDS || counts.other >= MAX_FRIENDS {
            return Err(DomainError::Conflict("Friends list is full".to_string()));
        }

        let row = sqlx::query!(
            r#"UPDATE friendships
               SET status = 'accepted', updated_at = now()
               WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
               RETURNING requester_id, addressee_id, status, created_at, updated_at"#,
            req,
            addressee,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        let row = row.ok_or_else(|| DomainError::NotFound {
            resource_type: "FriendRequest",
            id: requester.to_string(),
        })?;

        tx.commit().await.map_err(super::db_err)?;

        Ok(Friendship {
            requester_id: UserId::new(row.requester_id),
            addressee_id: UserId::new(row.addressee_id),
            status: parse_status(&row.status),
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    async fn delete_request(&self, caller: &UserId, other: &UserId) -> Result<bool, DomainError> {
        let a = caller.0;
        let b = other.0;
        let result = sqlx::query!(
            r#"DELETE FROM friendships
               WHERE status = 'pending'
                 AND ((requester_id = $1 AND addressee_id = $2)
                   OR (requester_id = $2 AND addressee_id = $1))"#,
            a,
            b,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(result.rows_affected() > 0)
    }

    async fn delete_friendship(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError> {
        let ua = a.0;
        let ub = b.0;
        let result = sqlx::query!(
            r#"DELETE FROM friendships
               WHERE status = 'accepted'
                 AND ((requester_id = $1 AND addressee_id = $2)
                   OR (requester_id = $2 AND addressee_id = $1))"#,
            ua,
            ub,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(result.rows_affected() > 0)
    }

    async fn list_friends(&self, user: &UserId) -> Result<Vec<FriendRow>, DomainError> {
        let uid = user.0;
        let rows = sqlx::query!(
            r#"SELECT
                p.id AS "user_id!",
                p.username AS "username!",
                p.display_name,
                p.avatar_url,
                f.updated_at AS "friends_since!"
               FROM friendships f
               JOIN profiles p
                 ON p.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
               WHERE f.status = 'accepted'
                 AND (f.requester_id = $1 OR f.addressee_id = $1)
               ORDER BY p.username ASC"#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|r| FriendRow {
                user_id: UserId::new(r.user_id),
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                friends_since: r.friends_since,
            })
            .collect())
    }

    async fn list_requests(
        &self,
        user: &UserId,
        direction: RequestDirection,
    ) -> Result<Vec<FriendRequestRow>, DomainError> {
        let uid = user.0;
        // WHY map inside each arm: the two `query!` invocations produce distinct
        // anonymous Record types that cannot unify across the match — collect each
        // into the shared domain `FriendRequestRow` before returning.
        let rows: Vec<FriendRequestRow> = match direction {
            RequestDirection::Incoming => sqlx::query!(
                r#"SELECT
                    p.id AS "user_id!",
                    p.username AS "username!",
                    p.display_name,
                    p.avatar_url,
                    f.created_at AS "created_at!"
                   FROM friendships f
                   JOIN profiles p ON p.id = f.requester_id
                   WHERE f.status = 'pending' AND f.addressee_id = $1
                   ORDER BY f.created_at DESC"#,
                uid,
            )
            .fetch_all(&self.pool)
            .await
            .map_err(super::db_err)?
            .into_iter()
            .map(|r| FriendRequestRow {
                user_id: UserId::new(r.user_id),
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                direction,
                created_at: r.created_at,
            })
            .collect(),
            RequestDirection::Outgoing => sqlx::query!(
                r#"SELECT
                    p.id AS "user_id!",
                    p.username AS "username!",
                    p.display_name,
                    p.avatar_url,
                    f.created_at AS "created_at!"
                   FROM friendships f
                   JOIN profiles p ON p.id = f.addressee_id
                   WHERE f.status = 'pending' AND f.requester_id = $1
                   ORDER BY f.created_at DESC"#,
                uid,
            )
            .fetch_all(&self.pool)
            .await
            .map_err(super::db_err)?
            .into_iter()
            .map(|r| FriendRequestRow {
                user_id: UserId::new(r.user_id),
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                direction,
                created_at: r.created_at,
            })
            .collect(),
        };

        Ok(rows)
    }

    async fn list_friend_ids(&self, user: &UserId) -> Result<Vec<UserId>, DomainError> {
        let uid = user.0;
        let rows = sqlx::query!(
            r#"SELECT
                (CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END) AS "friend_id!"
               FROM friendships
               WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)"#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(rows.into_iter().map(|r| UserId::new(r.friend_id)).collect())
    }

    async fn are_friends(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError> {
        let ua = a.0;
        let ub = b.0;
        let row = sqlx::query!(
            r#"SELECT EXISTS(
                SELECT 1 FROM friendships
                WHERE status = 'accepted'
                  AND ((requester_id = $1 AND addressee_id = $2)
                    OR (requester_id = $2 AND addressee_id = $1))
            ) AS "exists!""#,
            ua,
            ub,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.exists)
    }

    async fn count_friends(&self, user: &UserId) -> Result<i64, DomainError> {
        let uid = user.0;
        let row = sqlx::query!(
            r#"SELECT COUNT(*)::BIGINT AS "count!"
               FROM friendships
               WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)"#,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.count)
    }

    async fn count_outgoing_pending(&self, user: &UserId) -> Result<i64, DomainError> {
        let uid = user.0;
        let row = sqlx::query!(
            r#"SELECT COUNT(*)::BIGINT AS "count!"
               FROM friendships
               WHERE status = 'pending' AND requester_id = $1"#,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.count)
    }

    async fn create_block(
        &self,
        blocker: &UserId,
        blocked: &UserId,
    ) -> Result<BlockOutcome, DomainError> {
        let b1 = blocker.0;
        let b2 = blocked.0;

        let mut tx = self.pool.begin().await.map_err(super::db_err)?;

        let inserted = sqlx::query!(
            r#"INSERT INTO user_blocks (blocker_id, blocked_id)
               VALUES ($1, $2)
               ON CONFLICT (blocker_id, blocked_id) DO NOTHING
               RETURNING blocker_id"#,
            b1,
            b2,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        if inserted.is_none() {
            // Already blocked — nothing to tear down (idempotent PUT).
            tx.commit().await.map_err(super::db_err)?;
            return Ok(BlockOutcome::AlreadyBlocked);
        }

        // Tear down any friendship/pending request between the pair. The
        // canonical-pair unique index guarantees at most one row.
        let torn = sqlx::query!(
            r#"DELETE FROM friendships
               WHERE (requester_id = $1 AND addressee_id = $2)
                  OR (requester_id = $2 AND addressee_id = $1)
               RETURNING status"#,
            b1,
            b2,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(super::db_err)?;

        tx.commit().await.map_err(super::db_err)?;

        let outcome = match torn.map(|r| parse_status(&r.status)) {
            Some(FriendshipStatus::Accepted) => BlockOutcome::BlockedWasFriends,
            Some(FriendshipStatus::Pending) => BlockOutcome::BlockedWasPending,
            None => BlockOutcome::Blocked,
        };
        Ok(outcome)
    }

    async fn delete_block(&self, blocker: &UserId, blocked: &UserId) -> Result<bool, DomainError> {
        let b1 = blocker.0;
        let b2 = blocked.0;
        let result = sqlx::query!(
            r#"DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2"#,
            b1,
            b2,
        )
        .execute(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(result.rows_affected() > 0)
    }

    async fn list_blocks(&self, blocker: &UserId) -> Result<Vec<BlockedUserRow>, DomainError> {
        let uid = blocker.0;
        let rows = sqlx::query!(
            r#"SELECT
                p.id AS "user_id!",
                p.username AS "username!",
                p.display_name,
                p.avatar_url,
                ub.created_at AS "blocked_at!"
               FROM user_blocks ub
               JOIN profiles p ON p.id = ub.blocked_id
               WHERE ub.blocker_id = $1
               ORDER BY ub.created_at DESC"#,
            uid,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(super::db_err)?;

        Ok(rows
            .into_iter()
            .map(|r| BlockedUserRow {
                user_id: UserId::new(r.user_id),
                username: r.username,
                display_name: r.display_name,
                avatar_url: r.avatar_url,
                blocked_at: r.blocked_at,
            })
            .collect())
    }

    async fn count_blocks(&self, blocker: &UserId) -> Result<i64, DomainError> {
        let uid = blocker.0;
        let row = sqlx::query!(
            r#"SELECT COUNT(*)::BIGINT AS "count!" FROM user_blocks WHERE blocker_id = $1"#,
            uid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.count)
    }

    async fn is_blocked_between(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError> {
        let ua = a.0;
        let ub = b.0;
        let row = sqlx::query!(
            r#"SELECT EXISTS(
                SELECT 1 FROM user_blocks
                WHERE (blocker_id = $1 AND blocked_id = $2)
                   OR (blocker_id = $2 AND blocked_id = $1)
            ) AS "exists!""#,
            ua,
            ub,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.exists)
    }

    async fn share_non_dm_server(&self, a: &UserId, b: &UserId) -> Result<bool, DomainError> {
        let ua = a.0;
        let ub = b.0;
        let row = sqlx::query!(
            r#"SELECT EXISTS(
                SELECT 1
                FROM server_members sm1
                JOIN server_members sm2 ON sm1.server_id = sm2.server_id
                JOIN servers s ON s.id = sm1.server_id
                WHERE sm1.user_id = $1 AND sm2.user_id = $2 AND s.is_dm = false
            ) AS "exists!""#,
            ua,
            ub,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.exists)
    }

    async fn dm_send_blocked(
        &self,
        author: &UserId,
        channel_id: &ChannelId,
    ) -> Result<bool, DomainError> {
        let uid = author.0;
        let cid = channel_id.0;
        let row = sqlx::query!(
            r#"SELECT EXISTS(
                SELECT 1
                FROM channels c
                JOIN servers s ON s.id = c.server_id AND s.is_dm = true
                JOIN server_members other
                  ON other.server_id = s.id AND other.user_id <> $1
                JOIN user_blocks ub
                  ON (ub.blocker_id = $1 AND ub.blocked_id = other.user_id)
                  OR (ub.blocker_id = other.user_id AND ub.blocked_id = $1)
                WHERE c.id = $2
            ) AS "blocked!""#,
            uid,
            cid,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(super::db_err)?;
        Ok(row.blocked)
    }
}
