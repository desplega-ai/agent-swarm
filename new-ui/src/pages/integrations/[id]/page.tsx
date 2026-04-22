import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";

// Placeholder — the full detail/edit experience ships in Phase 3 of
// `thoughts/taras/plans/2026-04-21-integrations-ui.md`. Kept trivial so the
// route resolves and type-checks while we land the list page first.
export default function IntegrationDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4 p-2">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Integration: {id ?? "unknown"}</h1>
        <p className="text-sm text-muted-foreground">
          Phase 3 coming for <code className="font-mono text-xs">{id ?? "unknown"}</code>.
        </p>
      </div>
      <Button asChild size="sm" variant="outline">
        <Link to="/integrations">← Back to integrations</Link>
      </Button>
    </div>
  );
}
