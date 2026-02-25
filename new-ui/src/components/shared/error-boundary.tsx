import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <Card className="max-w-md w-full border-red-500/20">
            <CardContent className="p-8 text-center space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
                <AlertTriangle className="h-7 w-7 text-red-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Something went wrong</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {this.state.error?.message ?? "An unexpected error occurred."}
                </p>
              </div>
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button onClick={this.handleReset} variant="outline" className="gap-1.5">
                  <RotateCcw className="h-4 w-4" />
                  Try Again
                </Button>
                <Button asChild className="gap-1.5 bg-amber-600 hover:bg-amber-700">
                  <Link to="/">
                    <Home className="h-4 w-4" />
                    Go Home
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
