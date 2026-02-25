import { RouterProvider } from "react-router-dom";
import { Providers } from "./providers";
import { router } from "./router";

export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
