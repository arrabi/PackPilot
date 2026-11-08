-- pg_net defaults allow client roles to read its transient request queue.
-- Scheduler headers contain a Vault-backed credential; only the database worker
-- and administrative database roles should inspect requests/responses. Provider
-- ownership may preserve its PUBLIC grants; the subsequent signed-proof
-- migration therefore keeps the reusable key out of this queue entirely.
revoke all on table net.http_request_queue,net._http_response from public,anon,authenticated;
