use super::{Error, runtime::Runtime};
use crate::state::AppState;
use serde_json::Value;
use std::{io::Write, sync::Arc};

/// Arm a draft under the same writer lock that retires it before replacement input.
pub(super) fn arm(state: &AppState, peer: &str, pty: &str, epoch: u64) -> Result<Arc<()>, Error> {
    let writer = state.pty_writer(pty).ok_or(Error::State)?;
    let _writer = writer.lock();
    if !super::runtime::live(state, peer, pty, epoch) {
        return Err(Error::State);
    }
    let mut session = state
        .session_maps
        .session_states
        .get_mut(pty)
        .ok_or(Error::State)?;
    if session.turn_epoch != epoch || session.turn_interrupt_retired_epoch == Some(epoch) {
        return Err(Error::State);
    }
    let token = Arc::new(());
    session.turn_interrupt = Some(token.clone());
    Ok(token)
}

impl Runtime {
    pub(super) async fn stop_acp(&mut self, update: &Value) -> Result<bool, Error> {
        let Some(stopped) = update.get("stopped_message_generation") else {
            return Ok(false);
        };
        let Some(active) = &self.outbound.active else {
            return Ok(false);
        };
        if stopped["chat"]["type"] != "private"
            || stopped["chat"]["id"].as_i64() != Some(active.chat)
            || stopped["draft_id"].as_i64() != Some(active.draft)
            || !self.outbound.paths.allowlist()?.contains(&active.chat)
        {
            return Ok(false);
        }
        let Some(request) = self.requests.iter_mut().find(|r| r.id == active.request) else {
            return Ok(false);
        };
        let Some((connection, session, turn)) = request.recipient.stop_target(request.turn) else {
            return Ok(false);
        };
        request.failed = true;
        request.noticed = true;
        self.outbound.active = None;
        // The actor rechecks the expected turn atomically before sending cancel.
        self.state
            .acp
            .cancel_turn(connection, session, turn)
            .await
            .map_err(|_| Error::State)?;
        Ok(true)
    }

    pub(super) fn stop(&mut self, update: &Value) -> Result<bool, Error> {
        let Some(stopped) = update.get("stopped_message_generation") else {
            return Ok(false);
        };
        let chat = &stopped["chat"];
        let Some(chat_id) = chat["id"].as_i64() else {
            return Err(Error::Protocol);
        };
        if chat["type"] != "private" || !self.outbound.paths.allowlist()?.contains(&chat_id) {
            return Ok(false);
        }
        let draft = stopped["draft_id"].as_i64().ok_or(Error::Protocol)?;
        if !self
            .outbound
            .active
            .as_ref()
            .is_some_and(|a| a.chat == chat_id && a.draft == draft)
        {
            return Ok(false);
        }
        // Consume before writing: failures and duplicate updates never retry Escape.
        let active = self.outbound.active.take().ok_or(Error::State)?;
        let Some(token) = active.interrupt else {
            // A queued Stop withdraws the request, never an unrelated turn.
            if let Some(request) = self
                .requests
                .iter_mut()
                .find(|r| r.id == active.request && !r.working)
            {
                request.failed = true;
                request.noticed = true;
                return Ok(true);
            }
            return Ok(false);
        };
        let writer = self.state.pty_writer(&active.pty).ok_or(Error::State)?;
        let mut writer = writer.lock();
        if !self.live(&active.peer, &active.pty, active.epoch) {
            return Ok(false);
        }
        let owned = {
            let mut session = self
                .state
                .session_maps
                .session_states
                .get_mut(&active.pty)
                .ok_or(Error::State)?;
            if !session
                .turn_interrupt
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &token))
            {
                return Ok(false);
            }
            session.turn_interrupt.take()
        };
        drop(owned);
        if let Some(request) = self.requests.iter_mut().find(|r| r.id == active.request) {
            request.failed = true;
            request.noticed = true;
        }
        // This is an interrupt request, not composer text. Feeding a bare ESC
        // into InputLineBuffer would consume the replacement's first character.
        // Release SilenceState before write: captured writers process output inline.
        if let Some(silence) = self.state.session_maps.silence_states.get(&active.pty) {
            silence.lock().note_interrupt_requested();
        }
        writer
            .write_all(b"\x1b")
            .and_then(|()| writer.flush())
            .map_err(|_| Error::Transport)?;
        crate::pty_capture::record_input(&active.pty, b"\x1b");
        Ok(true)
    }
}
