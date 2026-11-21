import { ToastViewport } from "@astryxdesign/core/Toast";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceProvider } from "./lib/appearance.tsx";
import { queryClient, router } from "./router.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <ToastViewport position="bottomEnd" maxVisible={3}>
          <RouterProvider router={router} />
        </ToastViewport>
      </QueryClientProvider>
    </AppearanceProvider>
  </StrictMode>,
);
