import { RouterProvider } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "./providers";
import { router } from "./router";

export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
    </Providers>
  );
}
