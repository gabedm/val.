# State and recovery

| Area       | Saved state                                  | Recovery rule                                                             |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| Login      | Browser-bound state and server session       | Expired state needs a fresh login                                         |
| Import     | Connection phase, lease and revision         | Resume owned work; reconcile unknown browser creation                     |
| Onboarding | Conversation, proposal and confirmed needs   | Reload saved work; require confirmation before writes                     |
| Chat       | Durable request and reply checkpoint         | Reattach rather than duplicate a turn                                     |
| Research   | Batch, per-provider checkpoints and evidence | Resume pending work; retain incomplete coverage                           |
| Monitoring | Per-subscription cadence and next check      | Lease due work; keep results through pauses                               |
| Switching  | Consent digest, phase and financial evidence | Verify new activation before cancellation; never repeat uncertain actions |

Server ownership and revision checks govern every transition. The client displays state and sends actions; it cannot grant payment authority, change the allowance or mark work complete.

Stopping work does not erase an uncertain purchase or cost hold. Logout does not disconnect a retained provider profile.
