import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Tailwind first: it declares the layer order (theme, base, components, utilities) that the UI kit joins.
import "./index.css";
import "@nebula/game-ui/styles.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
