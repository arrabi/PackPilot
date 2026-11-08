# Notifications

PackPilot retains the Brevo API delivery worker, recipient gates, idempotent attempts, signed scheduling and opaque notification links. Configure your own server-only credentials and verified sender; keep delivery paused during installation. Staging must allow only its owned test inbox. Do not rewrite real parent mail into a test inbox or invoke authenticated dispatch as a deployment check.

See [the setup guide](../documentation/SETUP.md) and [configuration reference](../documentation/CONFIGURATION.md). The static website must never receive privileged database or mail credentials. Public examples contain no real household contacts or delivery records.
