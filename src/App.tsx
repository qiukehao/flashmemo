import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./App.css";
import MainShell from "./MainShell";
import ReviewPopup from "./components/ReviewPopup";

export default function App() {
  // One bundle, two windows: the popup window renders the review flow,
  // everything else is the management panel (SPEC §15).
  const isPopup = getCurrentWebviewWindow().label === "popup";
  return isPopup ? <ReviewPopup /> : <MainShell />;
}
