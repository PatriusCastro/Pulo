// The real island UI for the website, with tauri-demo.ts standing in for Windows.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";

try {
  localStorage.setItem("tab", JSON.stringify("now"));
} catch {
  // storage blocked: the island just starts on its default tab
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
