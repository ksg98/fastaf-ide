use super::backoff::Backoff;
use super::mail::{MailPort, Update};
use super::{BotApi, Config, Error, Owner, Paths, offset};
use std::time::Duration;

pub(crate) enum Poll {
    Accepted(usize),
    Backoff(Duration),
}

/// One polling owner; the mail port owns the in-memory inbox and safe wake.
pub(crate) struct Inbound<P: MailPort> {
    paths: Paths,
    config: Config,
    _owner: Owner,
    api: BotApi,
    port: P,
    backoff: Backoff,
    stopped: Option<Error>,
    conflicted: bool,
}
impl<P: MailPort> Inbound<P> {
    pub(crate) fn with_port(paths: Paths, port: P) -> Result<Option<Self>, Error> {
        let Some(config) = Config::load(&paths)? else {
            return Ok(None);
        };
        let owner = Owner::acquire(&paths)?;
        let api = BotApi::new(paths.clone())?;
        Ok(Some(Self {
            paths,
            config,
            _owner: owner,
            api,
            port,
            backoff: Backoff::default(),
            stopped: None,
            conflicted: false,
        }))
    }
    #[cfg(test)]
    pub(super) fn with_loopback(
        paths: Paths,
        address: std::net::SocketAddr,
        port: P,
    ) -> Result<Self, Error> {
        let mut inbound = Self::with_port(paths.clone(), port)?.ok_or(Error::Config)?;
        inbound.api = BotApi::loopback(paths, address);
        Ok(inbound)
    }

    /// True while another process polls the same bot token (HTTP 409).
    pub(crate) fn in_conflict(&self) -> bool {
        self.conflicted
    }

    /// One bounded poll. Stops last for this owner lifetime; restarting retries.
    pub(crate) async fn poll(&mut self) -> Result<Poll, Error> {
        if let Some(error) = self.stopped {
            return Err(error);
        }
        if let Some(delay) = self.backoff.remaining() {
            return Ok(Poll::Backoff(delay));
        }
        match self.poll_once().await {
            Ok(poll) => {
                self.backoff.reset();
                self.conflicted = false;
                Ok(poll)
            }
            Err(error) => {
                if error.is_fatal() {
                    self.stopped = Some(error);
                    tracing::error!(source="telegram",error=%error,
                        "Telegram polling stopped; restart after resolving the reported fault");
                    return Err(error);
                }
                let delay = self.backoff.failed(error);
                self.conflicted = error == Error::Conflict;
                match error {
                    Error::RateLimited(_) | Error::Transport | Error::Conflict => {
                        Ok(Poll::Backoff(delay))
                    }
                    _ => Err(error),
                }
            }
        }
    }

    async fn poll_once(&mut self) -> Result<Poll, Error> {
        let current = Config::load(&self.paths)?.ok_or(Error::Config)?;
        if current.bot_alias != self.config.bot_alias {
            return Err(Error::State);
        }
        let saved = offset::read(&self.paths);
        let values = self
            .api
            .get_updates(saved.unwrap_or(-1), if saved.is_none() { 0 } else { 25 })
            .await?;
        if saved.is_none() {
            let next = match values.last() {
                Some(value) => value
                    .get("update_id")
                    .and_then(serde_json::Value::as_i64)
                    .filter(|id| *id >= 0)
                    .and_then(|id| id.checked_add(1))
                    .ok_or(Error::Protocol)?,
                None => 0,
            };
            offset::write(&self.paths, next)?;
            return Ok(Poll::Accepted(0));
        }
        let mut next = saved.ok_or(Error::State)?;
        // Revalidate after the long poll; never deliver from a stale allowlist snapshot.
        let ids = self.paths.allowlist_entries()?;
        let mut updates = values
            .iter()
            .map(|value| {
                Update::parse(value, &ids, &self.config.bot_alias, "").map(|update| (update, value))
            })
            .collect::<Result<Vec<_>, _>>()?;
        updates.sort_by_key(|(update, _)| update.id);
        if updates
            .windows(2)
            .any(|pair| pair[0].0.id == pair[1].0.id && pair[0].1 != pair[1].1)
        {
            return Err(Error::Protocol);
        }
        let mut accepted = 0;
        for (update, value) in updates {
            if update.id < next {
                continue;
            }
            let candidate = update.id.checked_add(1).ok_or(Error::Protocol)?;
            if let Some((chat, reply)) =
                super::settings::pair_update(&self.paths, value, super::settings::now_ms())?
            {
                if matches!(reply, super::settings::SetupReply::Linked) {
                    // Pairing has consumed the credential. Commit it and every earlier
                    // handoff before feedback can fail and replay it as authorized mail.
                    offset::write(&self.paths, candidate)?;
                    let _ = self.port.setup_reply(chat, reply).await;
                } else {
                    self.port.setup_reply(chat, reply).await?;
                }
                next = candidate;
                continue;
            }
            // Pairing earlier in this batch may have authorized this chat.
            let update = Update::parse(
                value,
                &self.paths.allowlist_entries()?,
                &self.config.bot_alias,
                "",
            )?;
            self.port.update(value).await?;
            if let Some(mail) = update.mail
                && self.port.offer(&mail).await?
            {
                accepted += 1;
            }
            next = candidate;
        }
        if Some(next) != saved {
            offset::write(&self.paths, next)?;
        }
        Ok(Poll::Accepted(accepted))
    }
}

#[cfg(test)]
impl Inbound<super::mail::TestInbox> {
    pub(super) fn open(paths: Paths) -> Result<Option<Self>, Error> {
        Self::with_port(paths, super::mail::TestInbox::default())
    }
    pub(super) fn loopback(paths: Paths, address: std::net::SocketAddr) -> Result<Self, Error> {
        Self::with_loopback(paths, address, super::mail::TestInbox::default())
    }
    /// Observe the test mail port, not an adapter-retained queue.
    pub(super) fn pending(&self) -> Result<Vec<super::PendingMail>, Error> {
        Ok(self.port.by_id.values().cloned().collect())
    }
}
