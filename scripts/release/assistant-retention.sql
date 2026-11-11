-- Private drafts/receipts are temporary copies, not the scout record of history.
delete from private.pack_assistant_proposals where created_at < now() - interval '7 days';
delete from private.pack_assistant_usage where hour < now() - interval '2 days';
