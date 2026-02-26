import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
      <Button asChild variant="outline">
        <Link to="/">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Dashboard
        </Link>
      </Button>
    </div>
  );
}
