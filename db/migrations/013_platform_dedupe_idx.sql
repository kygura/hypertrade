-- store lastTerminalAt: the cooldown lookup per dedupe key.
create index if not exists opportunities_dedupe_terminal_idx on opportunities (dedupe_key, status_changed_at);
