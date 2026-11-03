# Deployment field notes

Keep 2–3 strong entries for the submission. Log everything while building; trim at the end.

## Template

### N. <Short title>
- **What happened:** what I was doing, what I expected, what I saw. Exact error message / status code / request id.
- **How I found the cause:** logs, "Why this reply", curl, MCP Inspector, docs page, etc.
- **Fix or workaround:** what I changed.
- **What Chord should change:** one concrete product/doc/API change the team could ship next week.

---

## Probes to record
- [ ] Does Chord pass the WhatsApp sender's number to MCP tools / the model?
- [ ] Are all skills applied per reply, or one picked by description?
- [ ] Credits per simulator turn
- [ ] `handover_to_human` available in the simulator?
- [ ] Paystack dedicated virtual account: can a transfer be simulated in test mode?
