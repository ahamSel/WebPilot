"use client";

import { ProviderForm } from "./ProviderForm";

export function SettingsView() {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="wp-titlebar flex min-w-0 shrink-0 items-center border-b border-wp-border px-4 py-3">
        <h1 className="min-w-0 truncate text-lg font-semibold text-wp-text">Settings</h1>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="w-full max-w-2xl min-w-0">
          <ProviderForm />
        </div>
      </div>
    </div>
  );
}
