import { ArrowRight, Brain, Code2, Inbox, Network } from "lucide-react";
import { Link } from "react-router-dom";
import { useAriaClientIntakes, useAriaEngineCatalog } from "@/api/hooks/use-ariahq";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

const engines = [
  {
    name: "DevFlow",
    description: "Product intake, specs, human gates, and Factory execution.",
    icon: Code2,
    href: "/devflow/pipeline",
    status: "Live",
  },
  {
    name: "POC Engine",
    description: "Evidence-first proof-of-concept research and delivery.",
    icon: Network,
    status: "Connect next",
  },
  {
    name: "Prep Engine",
    description: "Account and meeting preparation with traceable sources.",
    icon: Brain,
    status: "Connect next",
  },
  {
    name: "Deal Engine",
    description: "Governed commercial workflows and approvals.",
    icon: Network,
    status: "Connect next",
  },
];

export default function AriaHqPage() {
  const catalog = useAriaEngineCatalog();
  const intakes = useAriaClientIntakes();
  const activeDrafts =
    catalog.data?.drafts.filter((draft) => draft.status === "running").length ?? 0;

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="AriaHQ"
        description="One organizational agent. Governed engines for development and operations, grounded in shared evidence."
        action={
          <Button asChild size="sm">
            <Link to="/ariahq/knowledge">
              Ask Aria <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Published engines</CardDescription>
            <CardTitle className="text-3xl">{(catalog.data?.engines.length ?? 0) + 1}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            DevFlow plus contract-generated workflows.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Engine drafts</CardDescription>
            <CardTitle className="text-3xl">{activeDrafts}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Drafts have no executable authority until published.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Client intake</CardDescription>
            <CardTitle className="text-3xl">{intakes.data?.intakes.length ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Tenant-bound Slack reports linked into DevFlow.
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Engine portfolio</h2>
          <Button asChild variant="outline" size="sm">
            <Link to="/ariahq/engines">Open Engine Studio</Link>
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {engines.map((engine) => (
            <Card key={engine.name} className="shadow-none">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <engine.icon className="size-5 text-primary" />
                  <Badge variant="outline" size="tag">
                    {engine.status}
                  </Badge>
                </div>
                <CardTitle>{engine.name}</CardTitle>
                <CardDescription>{engine.description}</CardDescription>
              </CardHeader>
              {engine.href ? (
                <CardContent>
                  <Button asChild variant="ghost" className="px-0">
                    <Link to={engine.href}>
                      Open engine <ArrowRight />
                    </Link>
                  </Button>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </div>
      </section>

      <Card className="border-primary/20 bg-primary/[0.03] shadow-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Inbox className="size-5 text-primary" />
            <CardTitle>Context changes capability, not persona</CardTitle>
          </div>
          <CardDescription>
            Internal Aria can query organizational evidence and initiate governed actions. Client
            Aria can capture and report status only within that client's boundary.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
