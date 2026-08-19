import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * History-aware back button: returns to the actual previous page when the
 * user navigated here in-app, and falls back to a fixed route on deep links
 * (react-router marks the first in-app history entry with key "default").
 */
export function BackButton({
  fallback,
  label = "Back",
  iconOnly = false,
}: {
  fallback: string;
  label?: string;
  iconOnly?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const goBack = () => {
    if (location.key !== "default") void navigate(-1);
    else void navigate(fallback);
  };
  if (iconOnly) {
    return (
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={goBack}>
        <ArrowLeft className="size-4" />
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" className="w-fit" onClick={goBack}>
      <ArrowLeft className="size-4" />
      {label}
    </Button>
  );
}
