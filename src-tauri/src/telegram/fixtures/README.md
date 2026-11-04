# Telegram public example

`public-text-update.json` is extracted without schema changes from the first
"Message with text" example in Telegram's public webhook guide:
https://core.telegram.org/bots/webhooks#testing-your-bot-with-updates
Retrieved 2026-10-03. The example already contains fake IDs and names.
Tests may vary IDs/text explicitly to exercise our validation boundaries.
It is a recorded public reference example, not a live mint/Bot API capture.
Fake-server envelopes and HTTP status faults model the documented contract;
real response, draft, callback and Stop captures remain deferred.

The older public sample omits the modern required Chat.type. Inbound tests
explicitly supply `private` alongside their varied fake IDs/text, based on the
current Bot API Chat schema. This adaptation is not claimed as captured traffic.
