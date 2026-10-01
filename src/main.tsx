import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "./components/arc/foundation.css";
import "./styles.css";
import "./identity.css";
import "./arc-theme.css";
import { ToastStackProvider } from "./components/arc/toast-stack/toast-stack";
import App from "./App";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastStackProvider>
      <App />
    </ToastStackProvider>
  </React.StrictMode>,
);
