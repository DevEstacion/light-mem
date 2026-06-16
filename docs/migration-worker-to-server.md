# Worker To Server Migration

Light-Mem 13 keeps the worker path in place. Server beta is an additional runtime option for teams, deployable containers, API keys, and BullMQ/Valkey queues.

Compatibility commands remain available:

```sh
light-mem start
light-mem worker start
light-mem server start
```

The server storage boundary reads legacy worker data while adding server-owned projects, sessions, agent events, memory items, teams, API keys, and audit logs. Migrate adapters gradually by writing to `/v1/events` and `/v1/memories`; keep existing `/api/*` hook routes enabled until all clients move.
