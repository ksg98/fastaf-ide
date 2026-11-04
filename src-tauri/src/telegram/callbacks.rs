use super::{Error, mail::PendingMail, runtime::Runtime, tool::Button};
use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct Callbacks {
    entries: Vec<Choice>,
}
struct Choice {
    handle: String,
    chat: i64,
    message: i64,
    label: String,
    data: String,
}
impl Callbacks {
    pub(super) fn clear(&mut self) {
        self.entries.clear();
    }
}
impl Runtime {
    pub async fn send_buttons(
        &mut self,
        chat: i64,
        text: &str,
        rows: Vec<Vec<Button>>,
    ) -> Result<Value, Error> {
        let mut choices = Vec::new();
        let mut keyboard = Vec::new();
        for row in rows {
            let mut wire_row = Vec::new();
            for button in row {
                let handle = format!("tc1:{}", uuid::Uuid::new_v4().simple());
                wire_row.push(json!({"text":button.label,"callback_data":handle}));
                choices.push((handle, button));
            }
            keyboard.push(wire_row);
        }
        let markup = (!keyboard.is_empty()).then(|| json!({"inline_keyboard":keyboard}));
        self.callbacks.clear();
        let ids = self.outbound.send(chat, text, markup).await?;
        let message = *ids.last().ok_or(Error::Protocol)?;
        for (handle, button) in choices {
            self.callbacks.entries.push(Choice {
                handle,
                chat,
                message,
                label: button.label,
                data: button.data,
            });
        }
        Ok(json!({"message_ids":ids}))
    }

    pub async fn callback(&mut self, value: &Value) -> Result<bool, Error> {
        self.retire_registration();
        let Some(peer) = self.recipient_peer() else {
            return Ok(false);
        };
        let Some(query) = value.get("callback_query") else {
            return Ok(false);
        };
        let message = &query["message"];
        if message["date"].as_i64().is_none_or(|date| date <= 0) {
            return Ok(false);
        }
        let chat = &message["chat"];
        let Some(chat_id) = chat["id"].as_i64() else {
            return Ok(false);
        };
        if chat["type"] != "private"
            || !self.outbound.paths.allowlist()?.contains(&chat_id)
            || query["from"]["id"].as_i64() != Some(chat_id)
        {
            return Ok(false);
        }
        let Some(handle) = query["data"].as_str() else {
            return Ok(false);
        };
        let Some(query_id) = query["id"].as_str().filter(|s| !s.is_empty()) else {
            return Ok(false);
        };
        let Some(index) = self.callbacks.entries.iter().position(|c| {
            c.handle == handle
                && c.chat == chat_id
                && Some(c.message) == message["message_id"].as_i64()
        }) else {
            return Ok(false);
        };
        let choice = &self.callbacks.entries[index];
        let message_id = choice.message;
        let selected_label = choice.label.clone();
        let id = format!("tg:{}:choice:{}", self.config.bot_alias, handle);
        let selected = PendingMail {
            id: id.clone(),
            recipient: peer,
            content: json!({"channel":"telegram","kind":"callback","request_id":id,"chat_id":chat_id.to_string(),"message_id":message_id,"callback_id":query_id,"data":choice.data}).to_string(),
        };
        super::native::offer(&self.state, &self.adapter_sid, &selected).await?;
        // Consume all handles after native delivery; acknowledgement/edit are
        // attempted once and never replay the choice if Telegram rejects them.
        self.callbacks.entries.clear();
        let label = format!("Selected: {selected_label}");
        // Opaque callbacks are ordinary choices, never deterministic publish consent.
        let acknowledged = self
            .outbound
            .call(
                chat_id,
                "answerCallbackQuery",
                json!({"callback_query_id":query_id,"text":label}),
            )
            .await;
        // Preserve all delivered text while visibly retiring the choice keyboard.
        let edited = self.outbound.call(chat_id,"editMessageReplyMarkup",json!({"chat_id":chat_id,"message_id":message_id,"reply_markup":{"inline_keyboard":[[{"text":label,"disabled":{}}]]}})).await;
        acknowledged?;
        edited?;
        Ok(true)
    }
}
