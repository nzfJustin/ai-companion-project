import { createBrowserRouter } from "react-router";
import { Entry } from "./pages/Entry";
import { AIChat } from "./pages/AIChat";
import { MemoryLayer } from "./pages/MemoryLayer";
import { Insights } from "./pages/Insights";
import { ReEngagement } from "./pages/ReEngagement";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Entry,
  },
  {
    path: "/chat",
    Component: AIChat,
  },
  {
    path: "/memory",
    Component: MemoryLayer,
  },
  {
    path: "/insights",
    Component: Insights,
  },
  {
    path: "/re-engagement",
    Component: ReEngagement,
  },
]);
