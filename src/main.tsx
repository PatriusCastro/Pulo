import React from "react";
import ReactDOM from "react-dom/client";

// One bundle, two windows: the island, and the settings window (opened from the tray).
// Separate chunks so each window only loads its own CSS.
const page = location.hash === "#settings" ? import("./Settings") : import("./App");

page.then(({ default: Page }) =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Page />
    </React.StrictMode>,
  ),
);
