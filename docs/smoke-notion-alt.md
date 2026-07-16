# Notion alternatives smoke test

Generated: 2026-07-09T11:02:12.430Z
Base: http://127.0.0.1:8787

## Timing
| Metric | Value |
|--------|-------|
| Wall clock | 14.72s |
| Queue → start | 9.72s |
| Run (start → done) | 4.2s |
| Queue → done | 13.93s |
| Heartbeats observed | 6 |
| Final status | done |
| Worker queued count | 0 |

## Review results (0 new)
_none_

## Checks
- SolidWorks present: **false**
- Notion self in review: **false**
- Host duplicates: **0**


## Last progress heartbeat
```json
{
  "at": "2026-07-09T11:02:11.951Z",
  "found": 6,
  "phase": "done",
  "total": 9,
  "checked": 7
}
```

## Event log
- **0s** `start` BASE=http://127.0.0.1:8787
- **0.19s** `review_before` 
- **0.19s** `queue_request` POST /api/web-catalog/jobs/alternatives name=notion
- **0.5s** `queue_ok` 
- **0.6s** `status_change` 
- **0.6s** `heartbeat` 
- **10.36s** `status_change` 
- **10.37s** `heartbeat` 
- **11.44s** `heartbeat` 
- **12.53s** `heartbeat` 
- **13.59s** `heartbeat` 
- **14.65s** `status_change` 
- **14.65s** `heartbeat` 
- **14.72s** `review_after` 
- **14.72s** `analysis` 
