import "./App.css";
import MainShell from "./MainShell";
import ReviewPopup from "./components/ReviewPopup";
import { currentWindowLabel } from "./lib/env";

export default function App() {
  // One bundle, two windows: the popup window renders the review flow,
  // everything else is the management panel (SPEC §15). In browser mock mode
  // the view is selected with ?window=popup.
  const isPopup = currentWindowLabel() === "popup";
  return isPopup ? <ReviewPopup /> : <MainShell />;
}
