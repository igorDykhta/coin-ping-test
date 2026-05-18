import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@sqlrooms/ui";

import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="coin-ping-test-theme">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
