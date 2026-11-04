//! Request correlation outlives the ephemeral draft and recipient turn.
use super::{Error, runtime::Runtime};
use crate::{acp::AcpClientEvent, state::AppState};
use agent_client_protocol::schema::v1;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::time::Instant;

// Reversible presentation choices live here, not in recipient adapters.
pub(super) const RECEIVED_REACTION: &str = "👀";
const REACTIONS: [&str; 5] = [RECEIVED_REACTION, "👨‍💻", "🤔", "👍", "👎"];
const RECEIVED: &str = "FastAF ha ricevuto il messaggio";
const QUEUED: &str = "In coda: l’agente è occupato";
const WORKING: &str = "L’agente sta lavorando";
const WAITING: &str = "L’agente ti aspetta in FastAF";
const QUEUE_NOTICE: &str = "Ancora in coda: l’agente non ha iniziato";
const NO_REPLY: &str = "L’agente ha terminato senza rispondere";
const STOPPED: &str = "L’agente si è fermato prima di rispondere";
const QUEUE_TIMEOUT: Duration = Duration::from_secs(600);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ANSWER_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct Observation {
    pub started: bool,
    pub waiting: bool,
    pub ended: bool,
    pub failed: bool,
    pub mail_woken: bool,
    pub text: String,
    pub turn: Option<crate::acp::AcpTurnId>,
    connection: Option<crate::acp::AcpConnectionId>,
    session: Option<v1::SessionId>,
    prompt_turn: Option<crate::acp::AcpTurnId>,
}
impl Observation {
    fn event(&mut self, envelope: crate::acp::AcpEventEnvelope) {
        match envelope.event {
            AcpClientEvent::PromptSent { text } if !self.started => {
                self.prompt_turn = envelope.turn_id;
                self.mail_woken = text == crate::pty::PEER_MAIL_WAKE;
            }
            AcpClientEvent::TurnStarted if !self.started => {
                self.started = true;
                self.turn = envelope.turn_id;
                self.connection = Some(envelope.connection_id);
                self.session = envelope.session_id;
                self.mail_woken &= self.prompt_turn == self.turn;
            }
            // Never mix another turn's text or settlement into this request.
            event if self.started && !self.ended && envelope.turn_id == self.turn => match event {
                AcpClientEvent::PromptSent { text } => {
                    self.mail_woken = text == crate::pty::PEER_MAIL_WAKE;
                }
                AcpClientEvent::SessionUpdate { update } => {
                    if let v1::SessionUpdate::AgentMessageChunk(chunk) = *update
                        && let v1::ContentBlock::Text(text) = chunk.content
                    {
                        if self.text.len().saturating_add(text.text.len()) > MAX_ANSWER_BYTES {
                            self.failed = true;
                            self.ended = true;
                        } else {
                            self.text.push_str(&text.text);
                        }
                    }
                }
                AcpClientEvent::PermissionRequested { .. }
                | AcpClientEvent::ElicitationRequested { .. } => self.waiting = true,
                AcpClientEvent::PermissionSettled { .. }
                | AcpClientEvent::ElicitationSettled { .. } => self.waiting = false,
                AcpClientEvent::TurnSettled { .. } => self.ended = true,
                AcpClientEvent::TurnFailed { .. } => {
                    self.failed = true;
                    self.ended = true;
                }
                _ => {}
            },
            _ => {}
        }
    }
}

#[derive(Default)]
pub(super) struct AcpObservation {
    turns: std::collections::VecDeque<Observation>,
    pending_prompt: Option<crate::acp::AcpEventEnvelope>,
    failed: bool,
    gone: bool,
    idle: bool,
    #[cfg(test)]
    sequence: u64,
}
impl AcpObservation {
    fn unclaimed_turn(&self, claimed: &[crate::acp::AcpTurnId]) -> Option<crate::acp::AcpTurnId> {
        self.turns
            .iter()
            .find(|turn| turn.turn.is_some_and(|id| !claimed.contains(&id)))
            .and_then(|turn| turn.turn)
    }

    fn event(&mut self, envelope: crate::acp::AcpEventEnvelope) {
        #[cfg(test)]
        {
            self.sequence = envelope.sequence;
        }
        if matches!(&envelope.event, AcpClientEvent::ConnectionState { state }
            if matches!(state, crate::acp::AcpConnectionState::Closed | crate::acp::AcpConnectionState::Failed | crate::acp::AcpConnectionState::Killed))
        {
            self.gone = true;
            return;
        }
        if let AcpClientEvent::SessionUpdate { update } = &envelope.event
            && let v1::SessionUpdate::AgentMessageChunk(chunk) = update.as_ref()
            && let v1::ContentBlock::Text(text) = &chunk.content
            && self
                .turns
                .iter()
                .map(|turn| turn.text.len())
                .sum::<usize>()
                .saturating_add(text.text.len())
                > MAX_ANSWER_BYTES
        {
            self.failed = true;
            return;
        }
        if matches!(&envelope.event, AcpClientEvent::PromptSent { .. }) {
            self.pending_prompt = Some(envelope);
            return;
        }
        if matches!(&envelope.event, AcpClientEvent::TurnStarted) {
            self.idle = false;
        }
        if matches!(
            &envelope.event,
            AcpClientEvent::TurnSettled { .. } | AcpClientEvent::TurnFailed { .. }
        ) {
            self.idle = true;
        }
        if matches!(&envelope.event, AcpClientEvent::TurnStarted) {
            if self.turns.len() >= 8 {
                self.failed = true;
                return;
            }
            let mut turn = Observation::default();
            if let Some(prompt) = self.pending_prompt.take() {
                turn.event(prompt);
            }
            turn.event(envelope);
            self.turns.push_back(turn);
        } else if let Some(turn) = self
            .turns
            .iter_mut()
            .find(|turn| turn.turn == envelope.turn_id)
        {
            turn.event(envelope);
        }
        if self.turns.iter().map(|turn| turn.text.len()).sum::<usize>() > MAX_ANSWER_BYTES {
            self.failed = true;
        }
    }
}

pub(super) enum Recipient {
    Pty {
        pty: String,
        epoch: u64,
    },
    Acp {
        observation: Arc<parking_lot::Mutex<AcpObservation>>,
        reader: tokio::task::JoinHandle<()>,
    },
    Peer,
}
impl Drop for Recipient {
    fn drop(&mut self) {
        if let Self::Acp { reader, .. } = self {
            reader.abort();
        }
    }
}
impl Recipient {
    #[cfg(test)]
    pub fn observed_sequence(&self) -> u64 {
        if let Self::Acp { observation, .. } = self {
            observation.lock().sequence
        } else {
            0
        }
    }

    pub fn stop_target(
        &self,
        turn_id: Option<crate::acp::AcpTurnId>,
    ) -> Option<(
        crate::acp::AcpConnectionId,
        v1::SessionId,
        crate::acp::AcpTurnId,
    )> {
        let Self::Acp { observation, .. } = self else {
            return None;
        };
        let snapshot = observation.lock();
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.turn == turn_id && !turn.ended)?;
        Some((turn.connection?, turn.session.clone()?, turn.turn?))
    }

    pub fn capture(state: &AppState, peer: &str) -> Self {
        if let Some(pty) = state.live_pty_for_peer(peer) {
            let epoch = state
                .session_state_with_shell(&pty)
                .map_or(0, |s| s.turn_epoch);
            return Self::Pty { pty, epoch };
        }
        let Some((mut stream, idle)) = state.acp.subscribe_peer_tail(peer) else {
            return Self::Peer;
        };
        let observation = Arc::new(parking_lot::Mutex::new(AcpObservation {
            idle,
            ..Default::default()
        }));
        let target = observation.clone();
        // Drain the journal independently of Bot API I/O. A stalled phone never
        // blocks ACP's SDK reader, nor makes its answer fall off a bus buffer.
        let reader = tokio::spawn(async move {
            while let Some(event) = stream.recv().await {
                match event {
                    Ok(event) => {
                        let mut snapshot = target.lock();
                        snapshot.event(event);
                        if snapshot.failed {
                            break;
                        }
                    }
                    Err(_) => {
                        target.lock().failed = true;
                        break;
                    }
                }
            }
            let mut observation = target.lock();
            if observation.turns.back().is_none_or(|turn| !turn.ended) {
                observation.failed = true;
            }
        });
        Self::Acp {
            observation,
            reader,
        }
    }
}

pub(super) struct Request {
    pub id: String,
    pub chat: i64,
    pub message: Option<i64>,
    pub peer: String,
    pub recipient: Recipient,
    pub cursor: u64,
    pub turn: Option<crate::acp::AcpTurnId>,
    pub final_error: Option<Error>,
    pub final_epoch: Option<u64>,
    pub received: Instant,
    pub read: Option<Instant>,
    pub working: bool,
    pub waiting: bool,
    pub failed: bool,
    pub acknowledged: bool,
    pub noticed: bool,
    pub queued_notice: bool,
    pub completed: Option<Vec<i64>>,
    pub reaction: usize,
    pub reaction_sent: Option<usize>,
}
impl Runtime {
    pub(super) async fn reaction(&mut self, index: usize) {
        let request = &self.requests[index];
        if request.reaction_sent == Some(request.reaction) {
            return;
        }
        let Some(message) = request.message else {
            return;
        };
        let reaction = request.reaction;
        if self
            .outbound
            .call(
                request.chat,
                "setMessageReaction",
                json!({
                    "chat_id":request.chat,"message_id":message,
                    "reaction":[{"type":"emoji","emoji":REACTIONS[reaction]}],"is_big":false
                }),
            )
            .await
            .is_ok_and(|result| result == serde_json::Value::Bool(true))
        {
            self.requests[index].reaction_sent = Some(reaction);
        }
    }

    pub(super) async fn finish_request(&mut self, id: &str, text: &str) -> Result<Vec<i64>, Error> {
        super::outbound::chunks(text)?;
        let index = self.requests.iter().position(|r| r.id == id);
        if let Some(index) = index
            && let Some(ids) = &self.requests[index].completed
        {
            return self.requests[index]
                .final_error
                .map_or_else(|| Ok(ids.clone()), Err);
        }
        let chat = index
            .map(|i| self.requests[i].chat)
            .or_else(|| {
                self.pending
                    .iter()
                    .find(|(key, _)| key == id)
                    .map(|(_, chat)| *chat)
            })
            .map(Ok)
            .unwrap_or_else(|| self.destination())?;
        // A send clears Telegram's one chat draft even when another request
        // owned it. Recreate the oldest remaining request on the next tick.
        self.outbound.active = None;
        self.callbacks.clear();
        if let Some(index) = index {
            let claimed: Vec<_> = self.requests.iter().filter_map(|r| r.turn).collect();
            let request = &mut self.requests[index];
            let read = self
                .state
                .agent_read_cursor
                .get(&request.peer)
                .is_some_and(|cursor| *cursor >= request.cursor);
            if read
                && request.turn.is_none()
                && let Recipient::Acp { observation, .. } = &request.recipient
            {
                // Keep this answered turn reserved when completion drops its reader.
                request.turn = observation.lock().unclaimed_turn(&claimed);
            }
            // Claim before network I/O: an uncertain send must not be blindly retried.
            self.requests[index].completed = Some(vec![]);
            self.requests[index].final_epoch = self
                .state
                .live_pty_for_peer(&self.requests[index].peer)
                .and_then(|pty| self.state.session_state_with_shell(&pty))
                .map(|s| s.turn_epoch);
        }
        let ids = match self.outbound.send(chat, text, None).await {
            Ok(ids) => ids,
            Err(error) => {
                if let Some(index) = index {
                    self.requests[index].final_error = Some(error);
                    self.requests[index].reaction = 4;
                }
                return Err(error);
            }
        };
        self.pending.retain(|(key, _)| key != id);
        if let Some(index) = index {
            self.requests[index].completed = Some(ids.clone());
            self.requests[index].reaction = 3;
            self.requests[index].recipient = Recipient::Peer;
            self.stage("answered");
            self.reaction(index).await;
        }
        Ok(ids)
    }

    pub(super) fn stage(&self, stage: &'static str) {
        self.state
            .telegram_recent
            .lock()
            .record("out", "status", stage, None);
    }

    pub(super) async fn stream_tick(&mut self) {
        for i in 0..self.requests.len() {
            if self.requests[i].completed.is_some() {
                self.reaction(i).await;
                continue;
            }
            let state = self.state.clone();
            let claimed: Vec<_> = self.requests.iter().filter_map(|r| r.turn).collect();
            let request = &mut self.requests[i];
            let read = state
                .agent_read_cursor
                .get(&request.peer)
                .is_some_and(|cursor| *cursor >= request.cursor);
            if read && request.read.is_none() {
                request.read = Some(Instant::now());
            }
            let mut ended = false;
            let mut auto_final = None;
            match &request.recipient {
                Recipient::Pty { pty, epoch } => {
                    let snapshot = state.session_state_with_shell(pty);
                    if state.live_pty_for_peer(&request.peer).as_ref() != Some(pty)
                        || state.session_maps.exit_codes.contains_key(pty)
                        || snapshot.as_ref().is_none_or(|s| s.agent_type.is_none())
                    {
                        request.failed = true;
                    }
                    if let Some(s) = snapshot {
                        let busy =
                            matches!(s.agent_state.as_deref(), Some("working" | "awaiting_input"));
                        if read && s.turn_epoch != *epoch && busy {
                            request.working = true;
                        }
                        request.waiting =
                            request.working && s.agent_state.as_deref() == Some("awaiting_input");
                        ended = read && !busy;
                    }
                }
                Recipient::Acp { observation, .. } => {
                    let snapshot = observation.lock();
                    request.failed |= snapshot.failed;
                    ended = read && snapshot.idle;
                    if read && request.turn.is_none() {
                        request.turn = snapshot.unclaimed_turn(&claimed);
                    }
                    if let Some(observation) =
                        snapshot.turns.iter().find(|turn| turn.turn == request.turn)
                    {
                        request.working = read && observation.started;
                        request.waiting =
                            request.working && observation.waiting && !observation.ended;
                        request.failed |= observation.failed;
                        ended = observation.ended;
                        request.failed |= snapshot.gone && !observation.ended;
                        if read
                            && observation.ended
                            && observation.mail_woken
                            && !observation.failed
                            && !request.failed
                            && !observation.text.is_empty()
                        {
                            auto_final = Some(observation.text.clone());
                        }
                    } else if snapshot.gone {
                        request.failed = true;
                    }
                }
                Recipient::Peer => {}
            }
            let auto_final = auto_final.map(|text| (request.id.clone(), text));
            let acknowledge = request.working && !request.acknowledged;
            if acknowledge {
                request.acknowledged = true;
                request.reaction = 1;
            }
            if acknowledge {
                self.stage("working");
                self.reaction(i).await;
            }
            if let Some((id, text)) = auto_final {
                if let Err(error) = self.finish_request(&id, &text).await {
                    super::runtime::alert(&state, error);
                }
                continue;
            }
            let request = &mut self.requests[i];
            let notice = if request.failed && !request.noticed {
                request.noticed = true;
                Some(STOPPED)
            } else if ended
                && request
                    .read
                    .is_some_and(|read| read.elapsed() >= READ_TIMEOUT)
                && !request.noticed
            {
                request.noticed = true;
                request.failed = true;
                Some(NO_REPLY)
            } else if !request.failed
                && !request.working
                && request.received.elapsed() >= QUEUE_TIMEOUT
                && !request.queued_notice
            {
                request.queued_notice = true;
                Some(QUEUE_NOTICE)
            } else {
                None
            };
            if request.failed {
                request.recipient = Recipient::Peer;
            }
            let reaction = if request.failed {
                4
            } else if request.waiting {
                2
            } else if request.working {
                1
            } else {
                0
            };
            let changed = reaction != request.reaction;
            request.reaction = reaction;
            let chat = request.chat;
            if changed {
                self.stage(match reaction {
                    1 => "working",
                    2 => "waiting",
                    4 => "failed",
                    _ => "queued",
                });
            }
            if let Some(notice) = notice {
                self.outbound.active = None;
                if let Err(error) = self.outbound.send(chat, notice, None).await {
                    super::runtime::alert(&state, error);
                }
            }
            self.reaction(i).await;
        }
        self.show_oldest().await;
    }

    pub(super) async fn show_oldest(&mut self) {
        let Some(index) = self
            .requests
            .iter()
            .position(|r| r.completed.is_none() && !r.failed && (!r.queued_notice || r.working))
        else {
            return;
        };
        let request = &self.requests[index];
        let id = request.id.clone();
        if self
            .outbound
            .active
            .as_ref()
            .is_some_and(|a| a.request != id)
        {
            self.outbound.active = None;
        }
        if self.outbound.active.is_none() {
            let (pty, epoch) = match &request.recipient {
                Recipient::Pty { pty, .. } => (
                    pty.clone(),
                    self.state
                        .session_state_with_shell(pty)
                        .map_or(0, |s| s.turn_epoch),
                ),
                _ => (String::new(), 0),
            };
            let text = if request.working { WORKING } else { RECEIVED };
            let result = self
                .outbound
                .begin_text(
                    id.clone(),
                    request.peer.clone(),
                    pty,
                    epoch,
                    request.chat,
                    text,
                )
                .await;
            if let Err(error) = result {
                super::runtime::alert(&self.state, error);
                return;
            }
        }
        let request = &self.requests[index];
        let mut text = if request.waiting {
            WAITING
        } else if request.working {
            WORKING
        } else {
            QUEUED
        }
        .to_owned();
        if let Recipient::Acp { observation, .. } = &request.recipient {
            let snapshot = observation.lock();
            if let Some(observation) = snapshot.turns.iter().find(|turn| turn.turn == request.turn)
                && !observation.text.is_empty()
                && request.working
                && !request.waiting
            {
                text = format!("{}\n{}", super::outbound::PREVIEW_LABEL, observation.text);
            }
        }
        let queued = self
            .requests
            .iter()
            .filter(|r| r.completed.is_none() && !r.failed)
            .count()
            .saturating_sub(1);
        if queued > 0 {
            text.push_str(&format!(" (+{queued} in coda)"));
        }
        // Do not overwrite an agent-written preview with a routine status tick.
        if let Some(active) = &self.outbound.active
            && (request.waiting || !request.working || !active.authored)
        {
            self.outbound.status(&id, &text, false);
        }
        if request.working
            && let Some(active) = &mut self.outbound.active
            && active.interrupt.is_none()
            && !active.pty.is_empty()
        {
            if let Some(snapshot) = self.state.session_state_with_shell(&active.pty) {
                active.epoch = snapshot.turn_epoch;
            }
            if let Ok(token) =
                super::stop::arm(&self.state, &active.peer, &active.pty, active.epoch)
            {
                active.interrupt = Some(token);
            }
        }
    }
}
