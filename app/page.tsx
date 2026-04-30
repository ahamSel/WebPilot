"use client";

import { Shell } from "@/components/layout/Shell";
import { ChatView } from "@/components/chat/ChatView";
import { DetailedView } from "@/components/activity/DetailedView";
import { LibraryView } from "@/components/library/LibraryView";
import { ActivityView } from "@/components/activity/ActivityView";
import { SettingsView } from "@/components/settings/SettingsView";
import { useUIStore } from "@/stores/ui";

function ViewRouter() {
  const view = useUIStore((s) => s.view);
  const displayMode = useUIStore((s) => s.displayMode);

  switch (view) {
    case "home":
      return displayMode === "detailed" ? <DetailedView /> : <ChatView />;
    case "library":
      return <LibraryView />;
    case "activity":
      return <ActivityView />;
    case "settings":
      return <SettingsView />;
    default:
      return <ChatView />;
  }
}

export default function HomePage() {
  return (
    <Shell>
      <ViewRouter />
    </Shell>
  );
}
