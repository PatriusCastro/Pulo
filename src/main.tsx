import React from "react";
import ReactDOM from "react-dom/client";

// One bundle, three windows: the island, settings (from the tray or a shortcut) and the
// scratchpad. Separate chunks so each window only loads its own CSS.
const page =
  location.hash === "#settings" ? import("./Settings") : location.hash === "#scratchpad" ? import("./Scratchpad") : import("./App");

page.then(({ default: Page }) =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Page />
    </React.StrictMode>,
  ),
);
