import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const apply = () => document.documentElement.classList.toggle("dark", dark.matches);
apply();
dark.addEventListener("change", apply);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
