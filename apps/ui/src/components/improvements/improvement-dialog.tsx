import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSubmitImprovement } from "@/api/hooks/use-improvements";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { isValidImprovementEmail } from "./improvement-email";

export const IMPROVEMENT_TEXT_MAX = 4000;

export interface ImprovementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Suggest an improvement to the Agent Swarm team. A person's submit approves
 * and sends in one call (`sendNow`). If secret scrubbing changed the text, the
 * server keeps it pending so the person can review the redacted text in the
 * header popover first. The email is required.
 */
export function ImprovementDialog({ open, onOpenChange }: ImprovementDialogProps) {
  const { user } = useCurrentUser();
  const submit = useSubmitImprovement();
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (open) {
      setText("");
      setEmail(user?.email ?? "");
    }
  }, [open, user?.email]);

  const trimmed = text.trim();
  const emailValid = isValidImprovementEmail(email);
  const canSubmit =
    trimmed.length > 0 && trimmed.length <= IMPROVEMENT_TEXT_MAX && emailValid && !submit.isPending;

  const onSubmit = async () => {
    try {
      const improvement = await submit.mutateAsync({
        text: trimmed,
        email: email.trim(),
        sendNow: true,
        source: "ui",
      });
      if (improvement.status === "sent") {
        toast.success("Thanks. Your improvement was sent to the Agent Swarm team.");
      } else if (improvement.status === "failed") {
        toast.error("Could not send it. Retry from the Improvements button in the header.");
      } else {
        toast.info(
          "Part of the text looked like a secret and was redacted. Review and approve it from the Improvements button in the header.",
        );
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit the improvement.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggest an improvement</DialogTitle>
          <DialogDescription>
            Tell the Agent Swarm team what would make this better. Only the text, your email and
            this install's id are sent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="improvement-text">Improvement</Label>
            <Textarea
              id="improvement-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={IMPROVEMENT_TEXT_MAX}
              rows={5}
              placeholder="Let me retry failed tasks in bulk from the tasks page."
            />
            <p className="text-xs text-muted-foreground">
              {trimmed.length}/{IMPROVEMENT_TEXT_MAX}. Leave out names, repos, hosts and secrets.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="improvement-email">Your email</Label>
            <Input
              id="improvement-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              aria-invalid={!emailValid}
            />
            <p className="text-xs text-muted-foreground">So the team can follow up. Required.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submit.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
