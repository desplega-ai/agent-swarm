import { ArrowLeft, Check, CircleDot, Clock } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useMeeting } from "@/api/hooks/use-meetings";
import type { MeetingStatus } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_VARIANT: Record<MeetingStatus, "default" | "secondary" | "destructive"> = {
  open: "default",
  concluded: "secondary",
  cancelled: "destructive",
};

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export default function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: meeting, isLoading } = useMeeting(id ?? "");

  if (isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading meeting…</p>;
  }
  if (!meeting) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Link to="/meetings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to meetings
          </Button>
        </Link>
        <p className="text-sm text-muted-foreground">Meeting not found.</p>
      </div>
    );
  }

  const presentCount = meeting.attendance.filter((a) => a.present).length;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Link to="/meetings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to meetings
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">{meeting.title}</h1>
        <Badge variant={STATUS_VARIANT[meeting.status]}>{meeting.status}</Badge>
        {meeting.template ? <Badge variant="outline">{meeting.template}</Badge> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Agenda</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{meeting.agenda}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-sm">
            <span>Attendance</span>
            <span
              className={
                meeting.fullyAttended
                  ? "text-xs font-normal text-emerald-600 dark:text-emerald-400"
                  : "text-xs font-normal text-muted-foreground"
              }
            >
              {presentCount}/{meeting.attendance.length} contributed
              {meeting.fullyAttended ? " — gate satisfied" : ""}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1">
            {meeting.attendance.map((a) => (
              <li key={a.participant} className="flex items-center gap-2 text-sm">
                {a.present ? (
                  <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <CircleDot className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-mono text-xs">{shortId(a.participant)}</span>
                <span className="text-muted-foreground">
                  {a.present
                    ? `${a.contributionCount} contribution${a.contributionCount === 1 ? "" : "s"}`
                    : "pending"}
                </span>
              </li>
            ))}
            {meeting.attendance.length === 0 ? (
              <li className="text-sm text-muted-foreground">No participants listed.</li>
            ) : null}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Contributions ({meeting.contributions.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {meeting.contributions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contributions yet.</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {meeting.contributions.map((c) => (
                <li key={c.id} className="border-l-2 border-border pl-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{shortId(c.agentId)}</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> round {c.round}
                    </span>
                    <span>{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{c.content}</p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {meeting.conclusion ? (
        <Card className="border-emerald-500/40">
          <CardHeader>
            <CardTitle className="text-sm">Conclusion</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">{meeting.conclusion}</p>
            {meeting.concludedBy ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Concluded by <span className="font-mono">{shortId(meeting.concludedBy)}</span>
                {meeting.concludedAt ? ` · ${new Date(meeting.concludedAt).toLocaleString()}` : ""}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
