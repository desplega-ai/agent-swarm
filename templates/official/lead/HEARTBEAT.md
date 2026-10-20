# Heartbeat Checklist

## Standing Orders

- Check Slack for unaddressed requests older than 1 hour
- Review active tasks for any that seem stuck (no progress updates in 30+ min)
- If idle workers exist and unassigned tasks are available, investigate and route them
- Check for failed tasks — especially "worker session not found" failures which indicate interrupted work that may need re-creation
- Review reboot-retry tasks — verify they are progressing, cancel if work is no longer needed

## Tracked Items

- Live items only: active blockers and watch items. Cap 10, 20 max during a surge; prune before you add.
- Each item states its lift trigger and a calendar date as a bare `MM-DD` (e.g. `lift when X; check 08-22`) or `DELETE MM-DD`. A full `YYYY-MM-DD` stamp does not arm the gate.
- An item closes: move its durable facts to memory, then delete the line. Never strike it through.
